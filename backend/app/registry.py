"""Persisted, admin-managed registry: custom monitored services and guest
service-name overrides.

Both live in the mandatory account database (``settings.storage_db_path`` —
the same SQLite file as accounts and sessions) so they survive restarts
regardless of whether the opt-in metrics history is enabled.

- ``custom_services`` — services an admin adds for monitoring on top of the
  built-in catalogue in ``clients/probes.py``.
- ``guest_labels``    — per-VMID overrides for the service label shown in the
  Container & VMs table, replacing the hard-coded defaults in
  ``clients/proxmox.py``.
"""

from __future__ import annotations

import secrets
import time
from pathlib import Path
from typing import Any

import aiosqlite
import structlog

from .config import Settings

log = structlog.get_logger("registry")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS custom_services (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    icon         TEXT    NOT NULL DEFAULT 'cloud',
    descr        TEXT    NOT NULL DEFAULT '',
    internal_url TEXT    NOT NULL,
    ext_url      TEXT,
    created_by   TEXT,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_labels (
    vmid       INTEGER PRIMARY KEY,
    service    TEXT    NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL
);
"""

_db_path: str = ""


class RegistryError(Exception):
    """Expected, user-facing registry error (bad input, missing database)."""


# ---------------------------------------------------------------------------
# Schema / lifecycle
# ---------------------------------------------------------------------------


async def ensure_schema(settings: Settings) -> None:
    """Create the registry tables in the account database. Idempotent."""
    global _db_path
    _db_path = settings.storage_db_path
    if not _db_path:
        log.info("registry.disabled", reason="storage_db_path is empty")
        return
    Path(_db_path).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(_db_path) as db:
        await db.executescript(_SCHEMA)
        await db.commit()
    log.info("registry.ready", db=_db_path)


def _connect() -> aiosqlite.Connection:
    return aiosqlite.connect(_db_path)


def _require_db() -> None:
    if not _db_path:
        raise RegistryError("Registry nicht verfügbar — keine Datenbank konfiguriert")


def _normalise_url(raw: str, *, field: str) -> str:
    url = raw.strip()
    if not url:
        raise RegistryError(f"{field} darf nicht leer sein")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise RegistryError(f"{field} muss mit http:// oder https:// beginnen")
    return url


# ---------------------------------------------------------------------------
# Custom services
# ---------------------------------------------------------------------------


def _row_to_service(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "icon": row["icon"],
        "desc": row["descr"],
        "internal_url": row["internal_url"],
        "ext_url": row["ext_url"],
        "created_by": row["created_by"],
        "created_at": int(row["created_at"]),
        "custom": True,
    }


async def list_services() -> list[dict[str, Any]]:
    """All admin-created services, oldest-first. Empty when no DB is set."""
    if not _db_path:
        return []
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM custom_services ORDER BY created_at ASC, id ASC"
        ) as cur:
            return [_row_to_service(r) for r in await cur.fetchall()]


async def get_service(service_id: str) -> dict[str, Any] | None:
    if not _db_path:
        return None
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM custom_services WHERE id = ?", (service_id,)
        ) as cur:
            row = await cur.fetchone()
            return _row_to_service(row) if row else None


async def create_service(
    *,
    name: str,
    internal_url: str,
    icon: str = "cloud",
    desc: str = "",
    ext_url: str | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    """Insert a custom service. Raises RegistryError on invalid input."""
    _require_db()
    name = name.strip()
    if not name:
        raise RegistryError("Name darf nicht leer sein")
    internal = _normalise_url(internal_url, field="Interne URL")
    ext = (
        _normalise_url(ext_url, field="Externe URL")
        if ext_url and ext_url.strip()
        else None
    )
    service_id = f"custom-{secrets.token_hex(4)}"
    now = int(time.time())
    async with _connect() as db:
        await db.execute(
            """
            INSERT INTO custom_services
                (id, name, icon, descr, internal_url, ext_url, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                service_id,
                name,
                icon.strip() or "cloud",
                desc.strip(),
                internal,
                ext,
                created_by,
                now,
            ),
        )
        await db.commit()
    log.info("registry.service_created", id=service_id, name=name)
    created = await get_service(service_id)
    assert created is not None
    return created


async def update_service(
    service_id: str,
    *,
    name: str | None = None,
    icon: str | None = None,
    desc: str | None = None,
    internal_url: str | None = None,
    ext_url: str | None = None,
) -> dict[str, Any] | None:
    """Patch a custom service. Returns None when the id is unknown."""
    _require_db()
    sets: list[str] = []
    params: list[Any] = []
    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise RegistryError("Name darf nicht leer sein")
        sets.append("name = ?")
        params.append(cleaned)
    if icon is not None:
        sets.append("icon = ?")
        params.append(icon.strip() or "cloud")
    if desc is not None:
        sets.append("descr = ?")
        params.append(desc.strip())
    if internal_url is not None:
        sets.append("internal_url = ?")
        params.append(_normalise_url(internal_url, field="Interne URL"))
    if ext_url is not None:
        # An empty string clears the external endpoint.
        ext = _normalise_url(ext_url, field="Externe URL") if ext_url.strip() else None
        sets.append("ext_url = ?")
        params.append(ext)
    if not sets:
        return await get_service(service_id)
    params.append(service_id)
    async with _connect() as db:
        cur = await db.execute(
            f"UPDATE custom_services SET {', '.join(sets)} WHERE id = ?", params
        )
        await db.commit()
        if cur.rowcount == 0:
            return None
    log.info("registry.service_updated", id=service_id)
    return await get_service(service_id)


async def delete_service(service_id: str) -> bool:
    """Delete a custom service. Returns False when the id is unknown."""
    _require_db()
    async with _connect() as db:
        cur = await db.execute(
            "DELETE FROM custom_services WHERE id = ?", (service_id,)
        )
        await db.commit()
    deleted = (cur.rowcount or 0) > 0
    if deleted:
        log.info("registry.service_deleted", id=service_id)
    return deleted


# ---------------------------------------------------------------------------
# Guest service-label overrides
# ---------------------------------------------------------------------------


async def list_guest_labels() -> dict[int, str]:
    """VMID -> overridden service label. Empty when no DB is set."""
    if not _db_path:
        return {}
    async with _connect() as db:
        async with db.execute("SELECT vmid, service FROM guest_labels") as cur:
            return {int(r[0]): str(r[1]) for r in await cur.fetchall()}


async def set_guest_label(
    vmid: int, service: str, *, updated_by: str | None = None
) -> None:
    """Upsert the service label override for a guest."""
    _require_db()
    service = service.strip()
    if not service:
        raise RegistryError("Service-Name darf nicht leer sein")
    now = int(time.time())
    async with _connect() as db:
        await db.execute(
            """
            INSERT INTO guest_labels (vmid, service, updated_by, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(vmid) DO UPDATE SET
                service    = excluded.service,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at
            """,
            (vmid, service, updated_by, now),
        )
        await db.commit()


async def delete_guest_label(vmid: int) -> None:
    """Drop the override so the built-in default label applies again."""
    _require_db()
    async with _connect() as db:
        await db.execute("DELETE FROM guest_labels WHERE vmid = ?", (vmid,))
        await db.commit()


def reset_for_tests(db_path: str = "") -> None:
    """Test hook: point the module at a specific database file (or disable)."""
    global _db_path
    _db_path = db_path
