"""Tiny SQLite-backed history of service probes, guest metrics and WAN throughput.

Used for the "real" service uptime / response-time view and for the per-guest
+ per-network time-series charts in the v2 dashboard. The frontend in-memory
buffers reset on reload and can't survive a backend restart, so anything
worth charting goes through here.

Storage is *opt-in* via ``settings.storage_db_path``. An empty path disables
the module so it never tries to write to a missing volume. A failed
``ensure_schema`` (e.g. the directory doesn't exist and we can't create it)
likewise sets the global ``_enabled`` flag to False — recording then becomes
a no-op and read helpers return empty lists. The dashboard treats that the
same as "no history yet", so a broken DB never blanks the UI.

Tables:
- ``probe_history`` — one row per service probe (5–60 s cadence)
- ``service_incidents`` — append-only state-change log per service (started_ts,
  ended_ts NULL while still bad). Lets us answer "last_incident_iso" cheaply.
- ``guest_metrics`` — one row per guest per metrics-sample tick (60 s)
- ``network_metrics`` — one row per WAN snapshot per metrics-sample tick (60 s)
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

CREATE TABLE IF NOT EXISTS service_incidents (
    service_id  TEXT    NOT NULL,
    started_ts  INTEGER NOT NULL,
    ended_ts    INTEGER,
    worst_status TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_incidents_service_started
    ON service_incidents (service_id, started_ts DESC);

CREATE TABLE IF NOT EXISTS guest_metrics (
    ts          INTEGER NOT NULL,
    vmid        INTEGER NOT NULL,
    cpu_pct     REAL    NOT NULL,
    ram_used_b  INTEGER NOT NULL,
    ram_total_b INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_metrics_vmid_ts
    ON guest_metrics (vmid, ts);
CREATE INDEX IF NOT EXISTS idx_guest_metrics_ts
    ON guest_metrics (ts);

CREATE TABLE IF NOT EXISTS network_metrics (
    ts        INTEGER NOT NULL,
    down_mbit REAL    NOT NULL,
    up_mbit   REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_metrics_ts
    ON network_metrics (ts);
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


# ---------------------------------------------------------------------------
# Probe history
# ---------------------------------------------------------------------------


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


async def p95_ms(service_id: str, hours: int = 24) -> int | None:
    """95th percentile of response_ms over the last N hours. None if no data.

    SQLite has no native percentile aggregate, so we sort the window and pick
    the index by ordinal. Probe rates are low (one sample every 5–60 s, kept
    for at most ``history_retention_days``), so the full sort is cheap.
    """
    if not _enabled:
        return None
    cutoff = int(time.time()) - hours * 3600
    try:
        async with aiosqlite.connect(_db_path) as db:
            async with db.execute(
                """
                SELECT response_ms
                FROM probe_history
                WHERE service_id = ? AND ts >= ?
                ORDER BY response_ms ASC
                """,
                (service_id, cutoff),
            ) as cur:
                values = [int(r[0]) for r in await cur.fetchall()]
                if not values:
                    return None
                # 95th percentile, nearest-rank.
                idx = max(0, int(round(0.95 * len(values))) - 1)
                return values[idx]
    except aiosqlite.Error as e:
        log.warning("storage.p95_failed", service_id=service_id, error=str(e))
        return None


# ---------------------------------------------------------------------------
# Service incidents (state-change log)
# ---------------------------------------------------------------------------


async def update_service_incident(service_id: str, status: str) -> None:
    """Append-only incident bookkeeping.

    When a service flips to a non-ok status and there's no open incident, we
    insert a new one with ``ended_ts = NULL``. When it returns to ok we close
    the open incident. Existing in-flight incidents are left untouched on
    repeat non-ok probes — only the worst_status is bumped if the new state
    is more severe (warn -> err).
    """
    if not _enabled:
        return
    now = int(time.time())
    try:
        async with aiosqlite.connect(_db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT rowid, worst_status FROM service_incidents
                WHERE service_id = ? AND ended_ts IS NULL
                ORDER BY started_ts DESC LIMIT 1
                """,
                (service_id,),
            ) as cur:
                row = await cur.fetchone()
            open_id = int(row["rowid"]) if row else None
            open_worst = row["worst_status"] if row else None

            if status == "ok":
                if open_id is not None:
                    await db.execute(
                        "UPDATE service_incidents SET ended_ts = ? WHERE rowid = ?",
                        (now, open_id),
                    )
                    await db.commit()
                return

            # Non-ok status — open a new incident or escalate the existing one.
            if status not in ("warn", "err"):
                return  # `idle` doesn't count as an incident
            if open_id is None:
                await db.execute(
                    """
                    INSERT INTO service_incidents
                        (service_id, started_ts, ended_ts, worst_status)
                    VALUES (?, ?, NULL, ?)
                    """,
                    (service_id, now, status),
                )
                await db.commit()
                return
            # Escalate warn -> err.
            if open_worst == "warn" and status == "err":
                await db.execute(
                    "UPDATE service_incidents SET worst_status = ? WHERE rowid = ?",
                    ("err", open_id),
                )
                await db.commit()
    except aiosqlite.Error as e:
        log.warning("storage.incident_failed", service_id=service_id, error=str(e))


async def last_incident_ts(service_id: str) -> int | None:
    """Epoch seconds of the most recent incident transition (open or closed)."""
    if not _enabled:
        return None
    try:
        async with aiosqlite.connect(_db_path) as db:
            async with db.execute(
                """
                SELECT started_ts FROM service_incidents
                WHERE service_id = ?
                ORDER BY started_ts DESC LIMIT 1
                """,
                (service_id,),
            ) as cur:
                row = await cur.fetchone()
                if not row:
                    return None
                return int(row[0])
    except aiosqlite.Error as e:
        log.warning("storage.last_incident_failed", service_id=service_id, error=str(e))
        return None


# ---------------------------------------------------------------------------
# Guest metrics (CPU/RAM per guest, sampled by the metrics loop)
# ---------------------------------------------------------------------------


async def record_guest_metrics(
    samples: list[tuple[int, float, int, int]]
) -> None:
    """Append a batch of (vmid, cpu_pct, ram_used_b, ram_total_b) at "now"."""
    if not _enabled or not samples:
        return
    now = int(time.time())
    rows = [(now, vmid, cpu, ru, rt) for (vmid, cpu, ru, rt) in samples]
    try:
        async with aiosqlite.connect(_db_path) as db:
            await db.executemany(
                """
                INSERT INTO guest_metrics
                    (ts, vmid, cpu_pct, ram_used_b, ram_total_b)
                VALUES (?, ?, ?, ?, ?)
                """,
                rows,
            )
            await db.commit()
    except aiosqlite.Error as e:
        log.warning("storage.guest_metrics_failed", error=str(e))


async def guest_history(vmid: int, hours: int = 24, limit: int = 2000) -> list[dict]:
    """Return the most recent guest samples ordered oldest-first."""
    if not _enabled:
        return []
    cutoff = int(time.time()) - hours * 3600
    try:
        async with aiosqlite.connect(_db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT ts, cpu_pct, ram_used_b, ram_total_b
                FROM guest_metrics
                WHERE vmid = ? AND ts >= ?
                ORDER BY ts ASC
                LIMIT ?
                """,
                (vmid, cutoff, limit),
            ) as cur:
                rows = await cur.fetchall()
                return [
                    {
                        "ts": int(r["ts"]),
                        "cpu_pct": float(r["cpu_pct"]),
                        "ram_used_b": int(r["ram_used_b"]),
                        "ram_total_b": int(r["ram_total_b"]),
                    }
                    for r in rows
                ]
    except aiosqlite.Error as e:
        log.warning("storage.guest_history_failed", vmid=vmid, error=str(e))
        return []


# ---------------------------------------------------------------------------
# Network metrics (WAN throughput, sampled by the metrics loop)
# ---------------------------------------------------------------------------


async def record_network_metrics(down_mbit: float, up_mbit: float) -> None:
    if not _enabled:
        return
    try:
        async with aiosqlite.connect(_db_path) as db:
            await db.execute(
                "INSERT INTO network_metrics (ts, down_mbit, up_mbit) VALUES (?, ?, ?)",
                (int(time.time()), float(down_mbit), float(up_mbit)),
            )
            await db.commit()
    except aiosqlite.Error as e:
        log.warning("storage.network_metrics_failed", error=str(e))


async def network_history(hours: int = 1, limit: int = 2000) -> list[dict]:
    if not _enabled:
        return []
    cutoff = int(time.time()) - hours * 3600
    try:
        async with aiosqlite.connect(_db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT ts, down_mbit, up_mbit
                FROM network_metrics
                WHERE ts >= ?
                ORDER BY ts ASC
                LIMIT ?
                """,
                (cutoff, limit),
            ) as cur:
                rows = await cur.fetchall()
                return [
                    {
                        "ts": int(r["ts"]),
                        "down_mbit": float(r["down_mbit"]),
                        "up_mbit": float(r["up_mbit"]),
                    }
                    for r in rows
                ]
    except aiosqlite.Error as e:
        log.warning("storage.network_history_failed", error=str(e))
        return []


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


async def cleanup_old(retention_days: int) -> int:
    """Drop samples older than the configured retention window across all
    tables. Closed incidents (with ``ended_ts``) older than the window get
    pruned too; in-flight incidents are always kept. Returns the total
    number of rows removed."""
    if not _enabled:
        return 0
    cutoff = int(time.time()) - retention_days * 86400
    total = 0
    try:
        async with aiosqlite.connect(_db_path) as db:
            for stmt, params in (
                ("DELETE FROM probe_history WHERE ts < ?", (cutoff,)),
                ("DELETE FROM guest_metrics WHERE ts < ?", (cutoff,)),
                ("DELETE FROM network_metrics WHERE ts < ?", (cutoff,)),
                (
                    "DELETE FROM service_incidents WHERE ended_ts IS NOT NULL AND ended_ts < ?",
                    (cutoff,),
                ),
            ):
                async with db.execute(stmt, params) as cur:
                    total += cur.rowcount or 0
            await db.commit()
            if total:
                log.info("storage.cleanup", deleted=total, retention_days=retention_days)
            return total
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
