"""Smoke tests for weekly_report — covers the format helpers + build_report
with stubbed upstreams. Doesn't actually send mail."""

from __future__ import annotations

import pytest

from app import accounts, weekly_report
from app.models import ServiceStatus


@pytest.fixture
async def db(tmp_path, settings):
    settings_obj = settings.model_copy(
        update={"storage_db_path": str(tmp_path / "report.db")}
    )
    accounts.reset_for_tests("")
    await accounts.ensure_schema(settings_obj)
    yield settings_obj
    accounts.reset_for_tests("")


@pytest.fixture(autouse=True)
def _stub_storage(monkeypatch):
    """The reporter calls storage.uptime_pct / p95_ms / is_enabled — stub
    them with deterministic values so build_report doesn't need a populated
    storage backend."""
    import app.storage as storage
    monkeypatch.setattr(storage, "is_enabled", lambda: True)

    async def _uptime(_id, hours=168):  # noqa: ARG001
        return 99.42

    async def _p95(_id, hours=168):  # noqa: ARG001
        return 123

    monkeypatch.setattr(storage, "uptime_pct", _uptime)
    monkeypatch.setattr(storage, "p95_ms", _p95)


def _svc(sid: str) -> ServiceStatus:
    return ServiceStatus(
        id=sid, name=sid, sub="", icon="cloud", desc="",
        status="ok",
    )


async def test_build_report_aggregates(db, monkeypatch):
    async def fake_probe_all(_settings):
        return [_svc("vault"), _svc("cloud")]

    monkeypatch.setattr(weekly_report.probes, "probe_all", fake_probe_all)

    class FakeSummary:
        reachable = True
        total_today = 5
        success_today = 5

    async def fake_backup(_settings):
        return FakeSummary()

    monkeypatch.setattr(weekly_report.pbs, "fetch_backup_summary", fake_backup)

    report = await weekly_report.build_report(db)
    assert [r["id"] for r in report["services"]] == ["vault", "cloud"]
    assert report["services"][0]["uptime_pct"] == 99.42
    assert report["services"][0]["p95_ms"] == 123
    assert report["backups"]["total_today"] == 5


async def test_format_helpers_handle_empty_report():
    empty = {
        "generated_at": 1700000000,
        "period_start": 1700000000 - 604800,
        "services": [],
        "backups": None,
        "audit_runs_count": 0,
        "last_audit_summary": None,
    }
    html = weekly_report._format_html(empty)  # noqa: SLF001
    assert "<html" in html and "Wochenreport" in html
    text = weekly_report._format_text(empty)  # noqa: SLF001
    assert "Wochenreport" in text


async def test_send_report_raises_without_smtp_config(db, monkeypatch):
    async def fake_probe_all(_settings):
        return [_svc("vault")]

    async def fake_backup(_settings):
        return None

    monkeypatch.setattr(weekly_report.probes, "probe_all", fake_probe_all)
    monkeypatch.setattr(weekly_report.pbs, "fetch_backup_summary", fake_backup)
    with pytest.raises(RuntimeError, match="smtp_host"):
        await weekly_report.send_report(db)


def test_format_html_with_full_payload():
    payload = {
        "generated_at": 1700000000,
        "period_start": 1700000000 - 604800,
        "services": [
            {"id": "vault", "status": "ok", "uptime_pct": 99.9, "p95_ms": 80},
            {"id": "cloud", "status": "warn", "uptime_pct": 95.0, "p95_ms": 220},
        ],
        "backups": {"reachable": True, "total_today": 8, "success_today": 7},
        "audit_runs_count": 3,
        "last_audit_summary": {"ok": 10, "warn": 1, "err": 0, "skipped": 2},
    }
    html = weekly_report._format_html(payload)  # noqa: SLF001
    assert "vault" in html and "cloud" in html
    assert "7/8" in html  # backup counters
    assert "ok=10" in html
