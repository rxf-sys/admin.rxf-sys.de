from __future__ import annotations

import pytest

from app import storage
from app.config import Settings


@pytest.fixture
async def db(tmp_path):
    """Initialise a per-test SQLite file and tear it down afterwards."""
    db_path = tmp_path / "history.db"
    storage.reset_for_tests(str(db_path))
    s = Settings(storage_db_path=str(db_path))
    await storage.ensure_schema(s)
    yield s
    storage.reset_for_tests()


@pytest.mark.asyncio
async def test_disabled_when_path_empty():
    storage.reset_for_tests()
    s = Settings(storage_db_path="")
    await storage.ensure_schema(s)
    assert storage.is_enabled() is False
    assert await storage.recent_probes("vault") == []
    assert await storage.uptime_pct("vault") is None
    await storage.record_probes([("vault", "ok", 100)])  # no-op


@pytest.mark.asyncio
async def test_record_and_fetch_roundtrip(db):
    await storage.record_probes(
        [("vault", "ok", 100), ("cloud", "warn", 850)]
    )
    samples = await storage.recent_probes("vault", hours=1)
    assert len(samples) == 1
    assert samples[0]["status"] == "ok"
    assert samples[0]["ms"] == 100

    cloud = await storage.recent_probes("cloud", hours=1)
    assert cloud[0]["status"] == "warn"


@pytest.mark.asyncio
async def test_uptime_pct_counts_only_ok(db):
    # 3 ok / 1 warn / 1 err = 60%
    await storage.record_probes(
        [
            ("vault", "ok", 100),
            ("vault", "ok", 110),
            ("vault", "ok", 120),
            ("vault", "warn", 800),
            ("vault", "err", 4000),
        ]
    )
    pct = await storage.uptime_pct("vault", hours=1)
    assert pct == 60.0


@pytest.mark.asyncio
async def test_uptime_pct_none_when_no_samples(db):
    pct = await storage.uptime_pct("nonexistent", hours=1)
    assert pct is None


@pytest.mark.asyncio
async def test_cleanup_drops_old_rows(db):
    import time

    # Write a row with a manual old timestamp.
    import aiosqlite

    old_ts = int(time.time()) - 30 * 86400  # 30 days ago
    async with aiosqlite.connect(str(db.storage_db_path)) as conn:
        await conn.execute(
            "INSERT INTO probe_history (ts, service_id, status, response_ms) VALUES (?, ?, ?, ?)",
            (old_ts, "vault", "ok", 100),
        )
        await conn.commit()

    await storage.record_probes([("vault", "ok", 100)])  # fresh row
    deleted = await storage.cleanup_old(retention_days=7)
    assert deleted == 1

    samples = await storage.recent_probes("vault", hours=24 * 8)
    assert len(samples) == 1  # only the fresh one survived
