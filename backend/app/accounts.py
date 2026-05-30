"""Account + session storage for the dashboard's own authentication.

Replaces the previous Cloudflare-Access gate. Users authenticate against
local accounts (Argon2-hashed passwords) and receive an opaque, server-side
session token stored in an httpOnly cookie. Sessions live in SQLite so they
can be revoked instantly (logout, account disable/delete).

Two tables, kept in the same SQLite file as the metrics history
(``settings.storage_db_path``):

- ``users``    — one row per account, including a JSON blob of UI settings
- ``sessions`` — one row per active login, opaque token → user

Unlike ``storage.py`` (metrics history, opt-in), authentication is mandatory:
an empty ``storage_db_path`` raises on startup rather than silently disabling.
"""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any

import aiosqlite
import structlog
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from .config import Settings

log = structlog.get_logger("accounts")

_ph = PasswordHasher()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'viewer',
    realm         TEXT    NOT NULL DEFAULT 'local',
    source        TEXT    NOT NULL DEFAULT 'dashboard',
    settings_json TEXT    NOT NULL DEFAULT '{}',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    token_prefix TEXT    NOT NULL,
    scope        TEXT    NOT NULL DEFAULT 'read',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER,
    last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash);

CREATE TABLE IF NOT EXISTS user_totp (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_b32        TEXT    NOT NULL,
    enabled_at        INTEGER,
    backup_codes_json TEXT    NOT NULL DEFAULT '[]'
);
"""

_db_path: str = ""

# Available account roles. ``user`` is the legacy default kept so existing
# rows don't need migrating; new accounts default to ``viewer`` which is the
# minimum-privilege role (read-only, no admin pages). The 'operator' role is
# the middle ground — can trigger audits / service CRUD / acknowledge but
# not manage other accounts. Admin-routes still require the strict 'admin'
# role; the broader RBAC enforcement happens via ``role_in()`` below and the
# require_role dependency in app/auth.py.
ROLES = ("admin", "operator", "viewer", "user")
ADMIN_ROLES = frozenset({"admin"})
WRITE_ROLES = frozenset({"admin", "operator"})


def role_in(role: str, allowed: frozenset[str]) -> bool:
    """Strict membership check. Lives here (not in auth.py) so route modules
    can use it for in-handler permission checks without importing FastAPI."""
    return role in allowed
# Argon2 hashes are long; this caps the field defensively. The plaintext
# limit is enforced separately in the auth router.
MAX_SETTINGS_BYTES = 32_768


class AccountError(Exception):
    """Raised for expected, user-facing account errors (e.g. duplicate name)."""


# ---------------------------------------------------------------------------
# Schema / lifecycle
# ---------------------------------------------------------------------------


async def ensure_schema(settings: Settings) -> None:
    """Create the users + sessions tables. Raises if no DB path is configured."""
    global _db_path
    _db_path = settings.storage_db_path
    if not _db_path:
        raise RuntimeError(
            "storage_db_path must be set — account authentication requires a database"
        )
    parent = Path(_db_path).parent
    parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(_db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.executescript(_SCHEMA)
        await _migrate_users(db)
        await db.commit()
    log.info("accounts.ready", db=_db_path)


async def _migrate_users(db: aiosqlite.Connection) -> None:
    """Bring an older ``users`` table up to date.

    SQLite's CREATE TABLE IF NOT EXISTS only fires when the table is missing
    entirely — once it's there, new columns from _SCHEMA are silently ignored.
    This helper ALTERs in the optional columns added after the initial
    release (currently: realm, source) so an in-place upgrade from an old
    database doesn't break the read helpers."""
    async with db.execute("PRAGMA table_info(users)") as cur:
        cols = {row[1] for row in await cur.fetchall()}
    if "realm" not in cols:
        await db.execute("ALTER TABLE users ADD COLUMN realm TEXT NOT NULL DEFAULT 'local'")
        log.info("accounts.migrated", column="realm")
    if "source" not in cols:
        await db.execute("ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard'")
        log.info("accounts.migrated", column="source")


def _connect() -> aiosqlite.Connection:
    return aiosqlite.connect(_db_path)


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    return _ph.hash(plain)


def verify_password(stored_hash: str, plain: str) -> bool:
    try:
        _ph.verify(stored_hash, plain)
        return True
    except (VerifyMismatchError, Exception):  # noqa: BLE001 - any hash error = no match
        return False


def _row_to_user(row: aiosqlite.Row) -> dict[str, Any]:
    """Public user dict — never includes the password hash."""
    # ``realm`` and ``source`` may be missing on rows from a DB that hasn't
    # been migrated yet — fall back to the defaults so the API stays stable.
    keys = row.keys() if hasattr(row, "keys") else []
    realm = row["realm"] if "realm" in keys else "local"
    source = row["source"] if "source" in keys else "dashboard"
    return {
        "id": int(row["id"]),
        "username": row["username"],
        "email": row["email"],
        "role": row["role"],
        "realm": realm,
        "source": source,
        "disabled": bool(row["disabled"]),
        "created_at": int(row["created_at"]),
        "last_login_at": int(row["last_login_at"]) if row["last_login_at"] else None,
    }


# ---------------------------------------------------------------------------
# User CRUD
# ---------------------------------------------------------------------------


async def count_users() -> int:
    async with _connect() as db:
        async with db.execute("SELECT COUNT(*) FROM users") as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def create_user(
    username: str,
    password: str,
    *,
    role: str = "viewer",
    email: str | None = None,
    realm: str = "local",
    source: str = "dashboard",
) -> dict[str, Any]:
    """Insert a new account. Raises AccountError on a duplicate username."""
    username = username.strip()
    if not username:
        raise AccountError("Benutzername darf nicht leer sein")
    if role not in ROLES:
        raise AccountError(f"Ungültige Rolle: {role}")
    now = int(time.time())
    try:
        async with _connect() as db:
            cur = await db.execute(
                """
                INSERT INTO users (username, email, password_hash, role, realm, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (username, email, hash_password(password), role, realm, source, now),
            )
            await db.commit()
            user_id = cur.lastrowid
    except aiosqlite.IntegrityError as e:
        raise AccountError("Benutzername bereits vergeben") from e
    log.info("accounts.user_created", username=username, role=role, realm=realm, source=source)
    user = await get_user_by_id(int(user_id or 0))
    assert user is not None
    return user


async def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
            row = await cur.fetchone()
            return _row_to_user(row) if row else None


async def _get_user_row(username: str) -> aiosqlite.Row | None:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ) as cur:
            return await cur.fetchone()


async def list_users() -> list[dict[str, Any]]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users ORDER BY id ASC") as cur:
            return [_row_to_user(r) for r in await cur.fetchall()]


async def update_user(
    user_id: int,
    *,
    role: str | None = None,
    email: str | None = None,
    disabled: bool | None = None,
) -> dict[str, Any] | None:
    """Patch mutable user fields. Pass only the fields you want to change."""
    sets: list[str] = []
    params: list[Any] = []
    if role is not None:
        if role not in ROLES:
            raise AccountError(f"Ungültige Rolle: {role}")
        sets.append("role = ?")
        params.append(role)
    if email is not None:
        sets.append("email = ?")
        params.append(email)
    if disabled is not None:
        sets.append("disabled = ?")
        params.append(1 if disabled else 0)
    if not sets:
        return await get_user_by_id(user_id)
    params.append(user_id)
    async with _connect() as db:
        await db.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", params)
        # Disabling an account also kills its live sessions.
        if disabled:
            await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        await db.commit()
    return await get_user_by_id(user_id)


async def set_password(user_id: int, new_password: str) -> None:
    async with _connect() as db:
        await db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(new_password), user_id),
        )
        await db.commit()


async def delete_user(user_id: int) -> None:
    async with _connect() as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await db.commit()
    log.info("accounts.user_deleted", user_id=user_id)


async def admin_count(exclude_user_id: int | None = None) -> int:
    """Number of enabled admin accounts — used to block removing the last admin."""
    query = "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0"
    params: tuple[Any, ...] = ()
    if exclude_user_id is not None:
        query += " AND id != ?"
        params = (exclude_user_id,)
    async with _connect() as db:
        async with db.execute(query, params) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Per-user UI settings (opaque JSON blob owned by the frontend)
# ---------------------------------------------------------------------------


async def get_user_settings(user_id: int) -> dict[str, Any]:
    async with _connect() as db:
        async with db.execute(
            "SELECT settings_json FROM users WHERE id = ?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row or not row[0]:
        return {}
    try:
        parsed = json.loads(row[0])
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


async def set_user_settings(user_id: int, settings: dict[str, Any]) -> None:
    blob = json.dumps(settings, separators=(",", ":"))
    if len(blob.encode("utf-8")) > MAX_SETTINGS_BYTES:
        raise AccountError("Einstellungen zu groß")
    async with _connect() as db:
        await db.execute(
            "UPDATE users SET settings_json = ? WHERE id = ?", (blob, user_id)
        )
        await db.commit()


# ---------------------------------------------------------------------------
# Authentication + sessions
# ---------------------------------------------------------------------------


async def authenticate(username: str, password: str) -> dict[str, Any] | None:
    """Return the public user dict on valid credentials, else None.

    A disabled account never authenticates. The password is always verified
    (even for a missing user, against a throwaway hash) to keep the response
    time constant and avoid leaking which usernames exist.
    """
    row = await _get_user_row(username)
    if row is None:
        # Constant-time-ish: still run a verification against a dummy hash.
        verify_password(_DUMMY_HASH, password)
        return None
    if bool(row["disabled"]):
        return None
    if not verify_password(row["password_hash"], password):
        return None
    async with _connect() as db:
        await db.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (int(time.time()), int(row["id"])),
        )
        await db.commit()
    return _row_to_user(row)


# A pre-computed Argon2 hash of a random string, used to equalise timing on
# the "unknown username" path.
_DUMMY_HASH = _ph.hash("rxf-sys-timing-equaliser")


async def create_session(user_id: int, ttl_hours: int) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    async with _connect() as db:
        await db.execute(
            """
            INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token, user_id, now, now + ttl_hours * 3600, now),
        )
        await db.commit()
    return token


async def resolve_session(token: str) -> dict[str, Any] | None:
    """Validate a session token → public user dict, or None if invalid/expired.

    Expired sessions and sessions of disabled accounts are rejected (and the
    expired row is dropped). The session's ``last_seen_at`` is refreshed.
    """
    if not token:
        return None
    now = int(time.time())
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token = ?", (token,)
        ) as cur:
            srow = await cur.fetchone()
        if srow is None:
            return None
        if int(srow["expires_at"]) < now:
            await db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            await db.commit()
            return None
        async with db.execute(
            "SELECT * FROM users WHERE id = ?", (int(srow["user_id"]),)
        ) as cur:
            urow = await cur.fetchone()
        if urow is None or bool(urow["disabled"]):
            await db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            await db.commit()
            return None
        await db.execute(
            "UPDATE sessions SET last_seen_at = ? WHERE token = ?", (now, token)
        )
        await db.commit()
        return _row_to_user(urow)


async def delete_session(token: str) -> None:
    async with _connect() as db:
        await db.execute("DELETE FROM sessions WHERE token = ?", (token,))
        await db.commit()


async def get_app_setting(key: str) -> str | None:
    """Read a single value from the global app_settings key-value table.

    Returns None when the key is absent. Used for runtime-tunable UI
    settings (instance name, default timezone) that live outside the
    environment-driven Settings class."""
    if not _db_path:
        return None
    async with _connect() as db:
        async with db.execute("SELECT value FROM app_settings WHERE key = ?", (key,)) as cur:
            row = await cur.fetchone()
            return str(row[0]) if row else None


async def set_app_setting(key: str, value: str) -> None:
    """Upsert a value into app_settings. Caller is responsible for any
    domain validation (length, allowed characters, …)."""
    async with _connect() as db:
        await db.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        await db.commit()


async def list_active_sessions() -> list[dict[str, Any]]:
    """All non-expired sessions joined with their owning user.

    Used by the admin's 'Aktive Sessions' card. Returns one row per live
    session with the basic user identity attached and ordered by recency
    (last_seen_at, descending). Tokens are returned truncated — we never
    expose the full token to the UI."""
    now = int(time.time())
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT s.token, s.user_id, s.created_at, s.expires_at, s.last_seen_at,
                   u.username, u.email, u.role
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.expires_at > ?
            ORDER BY s.last_seen_at DESC
            """,
            (now,),
        ) as cur:
            rows = await cur.fetchall()
    return [
        {
            "token_prefix": (row["token"] or "")[:8],
            "user_id": int(row["user_id"]),
            "username": row["username"],
            "email": row["email"],
            "role": row["role"],
            "created_at": int(row["created_at"]),
            "expires_at": int(row["expires_at"]),
            "last_seen_at": int(row["last_seen_at"]),
        }
        for row in rows
    ]


async def revoke_session(token_prefix: str) -> int:
    """Delete sessions whose token starts with ``token_prefix``.

    Admins identify sessions by their 8-char prefix (the full token is never
    sent to the UI); the prefix space is large enough to make collisions
    rare but we still return the rowcount so the caller can detect an
    accidental match of zero or many rows."""
    if not token_prefix or len(token_prefix) < 6:
        return 0
    async with _connect() as db:
        cur = await db.execute(
            "DELETE FROM sessions WHERE token LIKE ?", (token_prefix + "%",)
        )
        await db.commit()
        return cur.rowcount or 0


# ---------------------------------------------------------------------------
# API tokens (long-lived bearer credentials, parallel to cookie sessions)
# ---------------------------------------------------------------------------

import hashlib  # noqa: E402

# Tokens are long random strings — sha256 is plenty (no rainbow tables risk
# since the entropy is server-side, unlike user passwords). We avoid argon2
# here because token-auth lookups have to be fast (we hash the incoming
# token and look it up by hash).
TOKEN_PREFIX_LEN = 12  # visible prefix for identification in the UI


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_api_token(
    user_id: int,
    name: str,
    *,
    scope: str = "read",
    ttl_days: int | None = None,
) -> tuple[str, dict[str, Any]]:
    """Create a new API token for ``user_id``.

    Returns the *raw* token (shown to the user exactly once) and the public
    metadata row. The raw token has the shape ``rxf_<43chars>`` and is never
    stored — only its sha256 hash lives in the DB.
    """
    raw = "rxf_" + secrets.token_urlsafe(32)
    token_hash = _hash_token(raw)
    prefix = raw[:TOKEN_PREFIX_LEN]
    now = int(time.time())
    expires_at = now + ttl_days * 86400 if ttl_days else None
    async with _connect() as db:
        cur = await db.execute(
            """
            INSERT INTO api_tokens
              (user_id, name, token_hash, token_prefix, scope, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (user_id, name.strip(), token_hash, prefix, scope, now, expires_at),
        )
        await db.commit()
        row_id = cur.lastrowid
    log.info("accounts.api_token_created", user_id=user_id, scope=scope, token_id=row_id)
    meta = {
        "id": int(row_id or 0),
        "user_id": user_id,
        "name": name.strip(),
        "token_prefix": prefix,
        "scope": scope,
        "created_at": now,
        "expires_at": expires_at,
        "last_used_at": None,
    }
    return raw, meta


async def list_api_tokens(user_id: int | None = None) -> list[dict[str, Any]]:
    """List tokens — for a specific user when ``user_id`` is given, otherwise
    all tokens across all users (admin view)."""
    query = """
        SELECT t.id, t.user_id, t.name, t.token_prefix, t.scope,
               t.created_at, t.expires_at, t.last_used_at, u.username
        FROM api_tokens t
        JOIN users u ON u.id = t.user_id
    """
    params: tuple[Any, ...] = ()
    if user_id is not None:
        query += " WHERE t.user_id = ?"
        params = (user_id,)
    query += " ORDER BY t.created_at DESC"
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, params) as cur:
            rows = await cur.fetchall()
    return [
        {
            "id": int(r["id"]),
            "user_id": int(r["user_id"]),
            "username": r["username"],
            "name": r["name"],
            "token_prefix": r["token_prefix"],
            "scope": r["scope"],
            "created_at": int(r["created_at"]),
            "expires_at": int(r["expires_at"]) if r["expires_at"] else None,
            "last_used_at": int(r["last_used_at"]) if r["last_used_at"] else None,
        }
        for r in rows
    ]


async def delete_api_token(token_id: int, user_id: int | None = None) -> bool:
    """Delete a token by id. When ``user_id`` is given, restricts the delete
    to tokens owned by that user (so a non-admin can only delete their own)."""
    async with _connect() as db:
        if user_id is not None:
            cur = await db.execute(
                "DELETE FROM api_tokens WHERE id = ? AND user_id = ?",
                (token_id, user_id),
            )
        else:
            cur = await db.execute("DELETE FROM api_tokens WHERE id = ?", (token_id,))
        await db.commit()
        return (cur.rowcount or 0) > 0


async def resolve_api_token(raw_token: str) -> dict[str, Any] | None:
    """Validate a raw bearer token → public user dict, or None.

    Mirrors resolve_session() so the auth dependency can swap in token-auth
    transparently. Updates last_used_at on success; rejects expired tokens
    and tokens whose owning user is disabled.
    """
    if not raw_token or not raw_token.startswith("rxf_"):
        return None
    token_hash = _hash_token(raw_token)
    now = int(time.time())
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, user_id, expires_at FROM api_tokens WHERE token_hash = ?",
            (token_hash,),
        ) as cur:
            trow = await cur.fetchone()
        if trow is None:
            return None
        if trow["expires_at"] and int(trow["expires_at"]) < now:
            return None
        async with db.execute(
            "SELECT * FROM users WHERE id = ?", (int(trow["user_id"]),)
        ) as cur:
            urow = await cur.fetchone()
        if urow is None or bool(urow["disabled"]):
            return None
        await db.execute(
            "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", (now, int(trow["id"]))
        )
        await db.commit()
        return _row_to_user(urow)


async def cleanup_expired_sessions() -> int:
    async with _connect() as db:
        cur = await db.execute(
            "DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),)
        )
        await db.commit()
        return cur.rowcount or 0


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


async def bootstrap_admin(settings: Settings) -> None:
    """Create the first admin account when the users table is empty.

    Skipped silently if accounts already exist. Logs a loud warning when the
    table is empty but no bootstrap password is configured — the dashboard is
    then unreachable until an admin is created out-of-band.
    """
    if await count_users() > 0:
        return
    if not settings.bootstrap_admin_password:
        log.warning(
            "accounts.no_admin",
            hint="set bootstrap_admin_password to create the first admin account",
        )
        return
    await create_user(
        settings.bootstrap_admin_user,
        settings.bootstrap_admin_password,
        role="admin",
        source="bootstrap",
    )
    log.info("accounts.admin_bootstrapped", username=settings.bootstrap_admin_user)


def reset_for_tests(db_path: str) -> None:
    """Test hook: point the module at a fresh database file."""
    global _db_path
    _db_path = db_path
