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


@pytest.mark.asyncio
async def test_p95_ms_nearest_rank(db):
    # 100 samples from 1..100 -> 95th percentile is 95
    await storage.record_probes([("vault", "ok", ms) for ms in range(1, 101)])
    p95 = await storage.p95_ms("vault", hours=1)
    assert p95 == 95


@pytest.mark.asyncio
async def test_p95_ms_none_without_samples(db):
    assert await storage.p95_ms("nonexistent", hours=1) is None


@pytest.mark.asyncio
async def test_incident_open_and_close(db):
    # ok -> nothing recorded
    await storage.update_service_incident("vault", "ok")
    assert await storage.last_incident_ts("vault") is None

    # transition to err opens an incident
    await storage.update_service_incident("vault", "err")
    first_ts = await storage.last_incident_ts("vault")
    assert first_ts is not None

    # subsequent err calls escalate but don't open a new incident
    await storage.update_service_incident("vault", "err")
    assert await storage.last_incident_ts("vault") == first_ts

    # back to ok closes the incident; last_incident_ts still points at the
    # most-recent started_ts.
    await storage.update_service_incident("vault", "ok")
    assert await storage.last_incident_ts("vault") == first_ts


@pytest.mark.asyncio
async def test_incident_warn_escalates_to_err(db):
    await storage.update_service_incident("cloud", "warn")
    await storage.update_service_incident("cloud", "err")
    # Should still be a single open incident with worst_status now "err".
    import aiosqlite
    async with aiosqlite.connect(str(db.storage_db_path)) as conn:
        async with conn.execute(
            "SELECT COUNT(*), MAX(worst_status) FROM service_incidents WHERE service_id='cloud' AND ended_ts IS NULL"
        ) as cur:
            row = await cur.fetchone()
    assert row[0] == 1
    assert row[1] == "err"


@pytest.mark.asyncio
async def test_guest_metrics_roundtrip(db):
    await storage.record_guest_metrics(
        [(100, 12.5, 500_000_000, 2_000_000_000), (101, 80.0, 1_500_000_000, 2_000_000_000)]
    )
    g100 = await storage.guest_history(100, hours=1)
    g101 = await storage.guest_history(101, hours=1)
    assert len(g100) == 1 and g100[0]["cpu_pct"] == 12.5
    assert len(g101) == 1 and g101[0]["ram_used_b"] == 1_500_000_000


@pytest.mark.asyncio
async def test_network_metrics_roundtrip(db):
    await storage.record_network_metrics(150.0, 45.0)
    samples = await storage.network_history(hours=1)
    assert len(samples) == 1
    assert samples[0]["down_mbit"] == 150.0
    assert samples[0]["up_mbit"] == 45.0


@pytest.mark.asyncio
async def test_cleanup_purges_all_tables(db):
    import time
    import aiosqlite

    old_ts = int(time.time()) - 30 * 86400
    async with aiosqlite.connect(str(db.storage_db_path)) as conn:
        await conn.execute(
            "INSERT INTO probe_history (ts, service_id, status, response_ms) VALUES (?, ?, ?, ?)",
            (old_ts, "vault", "ok", 100),
        )
        await conn.execute(
            "INSERT INTO guest_metrics (ts, vmid, cpu_pct, ram_used_b, ram_total_b) VALUES (?, ?, ?, ?, ?)",
            (old_ts, 100, 0.1, 1, 10),
        )
        await conn.execute(
            "INSERT INTO network_metrics (ts, down_mbit, up_mbit) VALUES (?, ?, ?)",
            (old_ts, 100.0, 10.0),
        )
        # Closed incident (eligible for purge) + open incident (always kept)
        await conn.execute(
            "INSERT INTO service_incidents (service_id, started_ts, ended_ts, worst_status) VALUES (?, ?, ?, ?)",
            ("vault", old_ts, old_ts + 100, "err"),
        )
        await conn.execute(
            "INSERT INTO service_incidents (service_id, started_ts, ended_ts, worst_status) VALUES (?, ?, ?, ?)",
            ("cloud", old_ts, None, "err"),
        )
        await conn.commit()

    deleted = await storage.cleanup_old(retention_days=7)
    assert deleted == 4  # 1 probe + 1 guest + 1 network + 1 closed incident

    # Open incident still there.
    async with aiosqlite.connect(str(db.storage_db_path)) as conn:
        async with conn.execute(
            "SELECT COUNT(*) FROM service_incidents WHERE service_id='cloud' AND ended_ts IS NULL"
        ) as cur:
            row = await cur.fetchone()
    assert row[0] == 1
