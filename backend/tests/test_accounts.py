from __future__ import annotations

import time

import pytest

from app import accounts
from app.config import Settings


@pytest.fixture
async def db(tmp_path):
    """A fresh accounts database per test."""
    path = str(tmp_path / "accounts.db")
    accounts.reset_for_tests(path)
    s = Settings(storage_db_path=path, auth_enabled=True)
    await accounts.ensure_schema(s)
    return s


async def test_create_and_fetch_user(db):
    user = await accounts.create_user("robin", "supersecret", role="admin", email="r@x.de")
    assert user["username"] == "robin"
    assert user["role"] == "admin"
    assert "password_hash" not in user  # never leaked
    fetched = await accounts.get_user_by_id(user["id"])
    assert fetched is not None
    assert fetched["email"] == "r@x.de"


async def test_duplicate_username_rejected(db):
    await accounts.create_user("robin", "supersecret")
    with pytest.raises(accounts.AccountError):
        await accounts.create_user("ROBIN", "anotherpw")  # case-insensitive clash


async def test_authenticate_paths(db):
    await accounts.create_user("robin", "supersecret")
    assert await accounts.authenticate("robin", "supersecret") is not None
    assert await accounts.authenticate("robin", "wrong") is None
    assert await accounts.authenticate("ghost", "whatever") is None


async def test_disabled_user_cannot_authenticate(db):
    user = await accounts.create_user("robin", "supersecret")
    await accounts.update_user(user["id"], disabled=True)
    assert await accounts.authenticate("robin", "supersecret") is None


async def test_session_lifecycle(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=1)
    resolved = await accounts.resolve_session(token)
    assert resolved is not None
    assert resolved["id"] == user["id"]
    await accounts.delete_session(token)
    assert await accounts.resolve_session(token) is None


async def test_expired_session_rejected(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=-1)  # already expired
    assert await accounts.resolve_session(token) is None


async def test_disabling_user_kills_sessions(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=24)
    await accounts.update_user(user["id"], disabled=True)
    assert await accounts.resolve_session(token) is None


async def test_user_settings_roundtrip(db):
    user = await accounts.create_user("robin", "supersecret")
    assert await accounts.get_user_settings(user["id"]) == {}
    await accounts.set_user_settings(user["id"], {"theme": "light", "density": "cozy"})
    assert await accounts.get_user_settings(user["id"]) == {
        "theme": "light",
        "density": "cozy",
    }


async def test_set_password_changes_credentials(db):
    user = await accounts.create_user("robin", "oldpassword")
    await accounts.set_password(user["id"], "newpassword")
    assert await accounts.authenticate("robin", "oldpassword") is None
    assert await accounts.authenticate("robin", "newpassword") is not None


async def test_admin_count_and_delete(db):
    a1 = await accounts.create_user("admin1", "supersecret", role="admin")
    await accounts.create_user("user1", "supersecret", role="user")
    assert await accounts.admin_count() == 1
    assert await accounts.admin_count(exclude_user_id=a1["id"]) == 0
    await accounts.delete_user(a1["id"])
    assert await accounts.get_user_by_id(a1["id"]) is None


async def test_bootstrap_creates_first_admin_only(db):
    s = Settings(
        storage_db_path=db.storage_db_path,
        bootstrap_admin_user="root",
        bootstrap_admin_password="bootstrap-pw",
    )
    await accounts.bootstrap_admin(s)
    users = await accounts.list_users()
    assert len(users) == 1
    assert users[0]["role"] == "admin"
    # Running again is a no-op once an account exists.
    await accounts.bootstrap_admin(s)
    assert len(await accounts.list_users()) == 1


async def test_cleanup_expired_sessions(db):
    user = await accounts.create_user("robin", "supersecret")
    await accounts.create_session(user["id"], ttl_hours=-1)
    await accounts.create_session(user["id"], ttl_hours=24)
    removed = await accounts.cleanup_expired_sessions()
    assert removed == 1


# ---- Session-token hashing ------------------------------------------------
#
# Stored under sha256(token) — the row never carries the plaintext, so a
# stolen SQLite file can't be replayed as a live cookie. These tests pin
# that contract so a future refactor can't quietly revert it.


async def test_session_token_not_stored_plaintext(db):
    import aiosqlite

    import hashlib

    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=1)

    async with aiosqlite.connect(db.storage_db_path) as raw:
        async with raw.execute("SELECT token_hash, token_prefix FROM sessions") as cur:
            rows = list(await cur.fetchall())
    assert len(rows) == 1
    token_hash, prefix = rows[0]
    # The raw token never appears anywhere in the DB.
    assert token_hash == hashlib.sha256(token.encode("utf-8")).hexdigest()
    assert token_hash != token
    # Prefix is the first 8 chars of the raw token for the admin UI.
    assert prefix == token[:8]
    # And resolution by hash still works end-to-end.
    resolved = await accounts.resolve_session(token)
    assert resolved is not None and resolved["id"] == user["id"]


async def test_revoke_by_prefix_uses_indexed_prefix_column(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=1)
    prefix = token[:8]

    # Wrong prefix — no effect.
    assert await accounts.revoke_session("zzzzzzzz") == 0
    assert await accounts.resolve_session(token) is not None

    # Right prefix — one row gone.
    assert await accounts.revoke_session(prefix) == 1
    assert await accounts.resolve_session(token) is None


async def test_list_active_sessions_exposes_only_prefix(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=1)
    sessions = await accounts.list_active_sessions()
    assert len(sessions) == 1
    s = sessions[0]
    assert s["token_prefix"] == token[:8]
    # Defence-in-depth: the row must never contain a full-token field.
    assert "token" not in s


async def test_legacy_plaintext_sessions_table_is_migrated(tmp_path):
    """Older databases stored ``sessions.token`` as the plaintext primary key.
    Reopening such a DB through ensure_schema must drop those rows so no
    plaintext token survives the upgrade."""
    import aiosqlite

    db_path = str(tmp_path / "legacy.db")
    # Seed the file with the pre-migration shape and a fake plaintext row.
    async with aiosqlite.connect(db_path) as raw:
        await raw.executescript(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email TEXT,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                settings_json TEXT NOT NULL DEFAULT '{}',
                disabled INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_login_at INTEGER
            );
            CREATE TABLE sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL
            );
            INSERT INTO users (username, password_hash, created_at) VALUES ('u', 'x', 1);
            INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
                VALUES ('plaintext-legacy-token', 1, 1, 9999999999, 1);
            """
        )
        await raw.commit()

    accounts.reset_for_tests(db_path)
    s = Settings(storage_db_path=db_path, auth_enabled=True)
    await accounts.ensure_schema(s)

    # Schema is up-to-date.
    async with aiosqlite.connect(db_path) as raw:
        async with raw.execute("PRAGMA table_info(sessions)") as cur:
            cols = {row[1] for row in await cur.fetchall()}
        assert "token_hash" in cols and "token_prefix" in cols and "token" not in cols
        async with raw.execute("SELECT COUNT(*) FROM sessions") as cur:
            row = await cur.fetchone()
        assert row[0] == 0  # legacy rows dropped (no way to hash w/o plaintext)
    _ = time.time()


async def test_list_active_sessions_excludes_expired_and_joins_user(db):
    alice = await accounts.create_user("alice", "supersecret", role="admin")
    bob = await accounts.create_user("bob", "supersecret")
    # Two live sessions and one already-expired session.
    await accounts.create_session(alice["id"], ttl_hours=24)
    await accounts.create_session(bob["id"], ttl_hours=24)
    await accounts.create_session(bob["id"], ttl_hours=-1)

    rows = await accounts.list_active_sessions()

    assert len(rows) == 2
    usernames = {r["username"] for r in rows}
    assert usernames == {"alice", "bob"}
    # User identity must be attached to each row.
    alice_row = next(r for r in rows if r["username"] == "alice")
    assert alice_row["role"] == "admin"
    assert alice_row["email"] is None
    # Token is never returned in full — only the short prefix.
    assert all(len(r["token_prefix"]) == 8 for r in rows)


async def test_revoke_session_matches_prefix(db):
    user = await accounts.create_user("robin", "supersecret")
    token1 = await accounts.create_session(user["id"], ttl_hours=24)
    await accounts.create_session(user["id"], ttl_hours=24)

    revoked = await accounts.revoke_session(token1[:8])
    assert revoked == 1
    # The other session is still live.
    assert len(await accounts.list_active_sessions()) == 1


async def test_revoke_session_rejects_short_prefix(db):
    user = await accounts.create_user("robin", "supersecret")
    await accounts.create_session(user["id"], ttl_hours=24)
    # Guard against accidentally revoking every session with an empty/very
    # short prefix.
    assert await accounts.revoke_session("") == 0
    assert await accounts.revoke_session("ab") == 0
    assert len(await accounts.list_active_sessions()) == 1
