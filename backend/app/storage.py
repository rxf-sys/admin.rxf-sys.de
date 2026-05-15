"""Tiny SQLite-backed history of service probe results.

Used for the "real" service uptime view — the in-memory rolling buffers in the
frontend reset on reload and can't survive a backend restart. Schema is a
single append-only table; retention is enforced by a periodic cleanup task in
the application lifespan (see ``main.py``).

Storage is *opt-in* via ``settings.storage_db_path``. An empty path disables
the module so it never tries to write to a missing volume. A failed
``ensure_schema`` (e.g. the directory doesn't exist and we can't create it)
likewise sets the global ``_enabled`` flag to False — recording then becomes
a no-op and ``recent_probes`` returns an empty list. The dashboard treats
that the same as "no history yet", so a broken DB never blanks the UI.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import aiosqlite
import structlog

from .config import Settings

log = structlog.get_logger("storage")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS probe_history (
    ts         INTEGER NOT NULL,
    service_id TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    response_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_history_service_ts
    ON probe_history (service_id, ts);
CREATE INDEX IF NOT EXISTS idx_probe_history_ts
    ON probe_history (ts);
"""

_enabled: bool = False
_db_path: str = ""


async def ensure_schema(settings: Settings) -> None:
    """Create the SQLite file + schema. Idempotent. Disables storage on error."""
    global _enabled, _db_path
    _db_path = settings.storage_db_path
    if not _db_path:
        _enabled = False
        log.info("storage.disabled", reason="storage_db_path is empty")
        return
    try:
        parent = Path(_db_path).parent
        parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(_db_path) as db:
            await db.executescript(_SCHEMA)
            await db.commit()
        _enabled = True
        log.info("storage.ready", db=_db_path)
    except OSError as e:
        _enabled = False
        log.warning(
            "storage.init_failed",
            db=_db_path,
            error=str(e),
            error_type=type(e).__name__,
        )


def is_enabled() -> bool:
    return _enabled


async def record_probes(samples: list[tuple[str, str, int]]) -> None:
    """Append a batch of (service_id, status, response_ms) samples at "now"."""
    if not _enabled or not samples:
        return
    now = int(time.time())
    rows = [(now, sid, status, ms) for sid, status, ms in samples]
    try:
        async with aiosqlite.connect(_db_path) as db:
            await db.executemany(
                "INSERT INTO probe_history (ts, service_id, status, response_ms) VALUES (?, ?, ?, ?)",
                rows,
            )
            await db.commit()
    except aiosqlite.Error as e:
        log.warning("storage.record_failed", error=str(e))


async def recent_probes(
    service_id: str, hours: int = 24, limit: int = 2000
) -> list[dict]:
    """Return the most recent samples for one service, newest last."""
    if not _enabled:
        return []
    cutoff = int(time.time()) - hours * 3600
    try:
        async with aiosqlite.connect(_db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT ts, status, response_ms
                FROM probe_history
                WHERE service_id = ? AND ts >= ?
                ORDER BY ts ASC
                LIMIT ?
                """,
                (service_id, cutoff, limit),
            ) as cur:
                rows = await cur.fetchall()
                return [
                    {"ts": int(r["ts"]), "status": r["status"], "ms": int(r["response_ms"])}
                    for r in rows
                ]
    except aiosqlite.Error as e:
        log.warning("storage.fetch_failed", service_id=service_id, error=str(e))
        return []


async def uptime_pct(service_id: str, hours: int = 24) -> float | None:
    """Percentage of samples in the window that reported ``ok``. None when
    there's no data."""
    if not _enabled:
        return None
    cutoff = int(time.time()) - hours * 3600
    try:
        async with aiosqlite.connect(_db_path) as db:
            async with db.execute(
                """
                SELECT
                    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                    COUNT(*) AS total
                FROM probe_history
                WHERE service_id = ? AND ts >= ?
                """,
                (service_id, cutoff),
            ) as cur:
                row = await cur.fetchone()
                if not row or not row[1]:
                    return None
                ok_count = int(row[0] or 0)
                total = int(row[1])
                return round((ok_count / total) * 100, 2)
    except aiosqlite.Error as e:
        log.warning("storage.uptime_failed", service_id=service_id, error=str(e))
        return None


async def cleanup_old(retention_days: int) -> int:
    """Drop samples older than the configured retention. Returns deleted rows."""
    if not _enabled:
        return 0
    cutoff = int(time.time()) - retention_days * 86400
    try:
        async with aiosqlite.connect(_db_path) as db:
            async with db.execute(
                "DELETE FROM probe_history WHERE ts < ?", (cutoff,)
            ) as cur:
                deleted = cur.rowcount or 0
            await db.commit()
            if deleted:
                log.info("storage.cleanup", deleted=deleted, retention_days=retention_days)
            return deleted
    except aiosqlite.Error as e:
        log.warning("storage.cleanup_failed", error=str(e))
        return 0


def reset_for_tests(db_path: str = ":memory:") -> None:
    """Test hook: forget the cached path so the next ensure_schema picks up
    the override. The bare ``:memory:`` placeholder makes obvious that this is
    not for production."""
    global _enabled, _db_path
    _enabled = False
    _db_path = db_path
    # Ensure no stale file is left behind between test runs when a real path
    # is used. We don't try to delete ``:memory:``.
    if db_path != ":memory:" and os.path.exists(db_path):
        try:
            os.unlink(db_path)
        except OSError:
            pass
