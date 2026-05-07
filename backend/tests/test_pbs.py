from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest
import respx

from app.clients import pbs


@pytest.mark.asyncio
@respx.mock
async def test_pbs_unreachable_marks_summary(settings):
    base = f"https://{settings.pbs_host}:{settings.pbs_port}/api2/json"
    respx.get(f"{base}/status/datastore-usage").mock(
        side_effect=httpx.ConnectError("refused")
    )

    summary = await pbs.fetch_backup_summary(settings)

    assert summary.reachable is False
    assert summary.error is not None
    assert "PBS" in summary.error
    assert summary.jobs == []
    assert summary.datastore is None


@pytest.mark.asyncio
async def test_pbs_missing_token_marks_summary_unreachable():
    from app.config import Settings

    settings = Settings(pbs_token_id="", pbs_token_secret="")
    summary = await pbs.fetch_backup_summary(settings)

    assert summary.reachable is False
    assert "Token" in (summary.error or "")


@pytest.mark.asyncio
@respx.mock
async def test_pbs_summary_counts_today(settings):
    base = f"https://{settings.pbs_host}:{settings.pbs_port}/api2/json"
    today_ts = int(datetime.now(timezone.utc).timestamp())
    respx.get(f"{base}/status/datastore-usage").respond(
        200,
        json={
            "data": [
                {"store": settings.pbs_datastore, "used": 50, "total": 100},
                {"store": "other", "used": 1, "total": 10},
            ]
        },
    )
    respx.get(f"{base}/admin/datastore/{settings.pbs_datastore}/snapshots").respond(
        200,
        json={
            "data": [
                {
                    "backup-time": today_ts,
                    "backup-type": "ct",
                    "backup-id": "100",
                    "size": 12345,
                    "verification": {"state": "ok"},
                },
                {
                    "backup-time": today_ts - 100,
                    "backup-type": "ct",
                    "backup-id": "101",
                    "size": 9999,
                    "verification": {"state": "failed"},
                },
            ]
        },
    )

    summary = await pbs.fetch_backup_summary(settings)

    assert summary.reachable is True
    assert summary.error is None
    assert summary.datastore is not None
    assert summary.datastore.used_pct == 50.0
    assert summary.success_today == 1
    assert summary.total_today == 2
    assert summary.last_success_iso is not None
    assert len(summary.jobs) == 2
