"""End-to-end coverage for the previously-untested routers.

Hits the happy path of /api/tunnel, /api/certs, /api/network,
/api/instance, /api/notifications — all of which used to sit at 0%
coverage. Upstream client calls are monkey-patched so the tests run
without a live PVE / PBS / Cloudflare / UniFi.

Auth is bypassed via ``AUTH_ENABLED=false`` so we can exercise the
router handlers and Pydantic response shapes without re-doing login
in every test."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import accounts
from app.cache import cache as global_cache
from app.config import get_settings
from app.models import (
    BackupSummary,
    CertInfo,
    DNSRecordCheck,
    NetworkSnapshot,
    TunnelStatus,
)
from app.routers import (
    backups as backups_router,
    certs as certs_router,
    instance as instance_router,
    network as network_router,
    notifications as notifications_router,
    tunnel as tunnel_router,
)


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "misc-routers.db")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    monkeypatch.setenv("INSTANCE_NAME", "rxf-test")
    get_settings.cache_clear()
    accounts.reset_for_tests(db)
    await accounts.ensure_schema(get_settings())
    global_cache.invalidate()

    app = FastAPI()
    app.include_router(tunnel_router.router)
    app.include_router(certs_router.router)
    app.include_router(network_router.router)
    app.include_router(instance_router.router)
    app.include_router(notifications_router.router)
    app.include_router(backups_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    global_cache.invalidate()
    get_settings.cache_clear()


# ---- /api/tunnel ----------------------------------------------------------


async def test_tunnel_endpoint_returns_status(client, monkeypatch):
    from app.clients import cloudflare

    async def _fake_tunnel(_s):
        return TunnelStatus(
            id="t1",
            name="main",
            status="healthy",
            connections=4,
            regions=["fra", "ams"],
            cloudflared_version="2026.1.0",
            wan_ip=None,
            reachable=True,
            error=None,
        )

    async def _fake_wan_ip():
        return "1.2.3.4"

    monkeypatch.setattr(cloudflare, "fetch_tunnel_status", _fake_tunnel)
    monkeypatch.setattr(cloudflare, "fetch_wan_ip", _fake_wan_ip)

    r = await client.get("/api/tunnel")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "healthy"
    assert body["wan_ip"] == "1.2.3.4"
    assert body["connections"] == 4


# ---- /api/certs -----------------------------------------------------------


async def test_certs_endpoint_returns_snapshot(client, monkeypatch):
    from app.clients import cloudflare

    async def _fake_certs(_s):
        return ([CertInfo(domain="rxf-sys.de", issuer="LE", days_left=42)], None)

    async def _fake_dns(_s):
        return [
            DNSRecordCheck(
                name="rxf-sys.de", type="A", content="1.2.3.4", expected="1.2.3.4", ok=True
            )
        ]

    monkeypatch.setattr(cloudflare, "fetch_certs", _fake_certs)
    monkeypatch.setattr(cloudflare, "fetch_dns_consistency", _fake_dns)

    r = await client.get("/api/certs")
    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is True
    assert body["error"] is None
    assert len(body["certs"]) == 1 and body["certs"][0]["domain"] == "rxf-sys.de"
    assert body["dns"][0]["ok"] is True
    assert body["dns"][0]["name"] == "rxf-sys.de"


async def test_certs_error_surfaces_as_unreachable(client, monkeypatch):
    from app.clients import cloudflare

    async def _fake_certs(_s):
        return ([], "Cloudflare API 403")

    async def _fake_dns(_s):
        return []

    monkeypatch.setattr(cloudflare, "fetch_certs", _fake_certs)
    monkeypatch.setattr(cloudflare, "fetch_dns_consistency", _fake_dns)

    r = await client.get("/api/certs")
    body = r.json()
    assert body["reachable"] is False
    assert "403" in body["error"]


# ---- /api/network ---------------------------------------------------------


async def test_network_endpoint_uses_unifi_snapshot(client, monkeypatch):
    from app.clients import unifi

    snap = NetworkSnapshot(
        wan_ip="1.2.3.4",
        isp="Vodafone",
        throughput_down_mbit=42.0,
        throughput_up_mbit=5.0,
        clients_total=12,
        clients_wired=4,
        clients_wireless=8,
        reachable=True,
        auth_mode="api-key",
    )

    async def _fake_snap(_s):
        return snap

    monkeypatch.setattr(unifi, "fetch_network_snapshot", _fake_snap)

    r = await client.get("/api/network")
    assert r.status_code == 200
    body = r.json()
    assert body["wan_ip"] == "1.2.3.4"
    assert body["clients_total"] == 12


async def test_network_throughput_caps_hours_to_24(client):
    # ensure_schema for the accounts DB doesn't initialise the metrics
    # storage layer, so is_enabled() is False here — the handler still
    # returns the wrapped shape with empty samples and a zero peak.
    r = await client.get("/api/network/throughput?hours=999")
    assert r.status_code == 200
    body = r.json()
    assert body["hours"] == 24  # 999 capped down to 24
    assert body["peak_down_mbit"] == 0.0
    assert body["samples"] == []


# ---- /api/instance --------------------------------------------------------


async def test_instance_get_returns_defaults(client):
    r = await client.get("/api/instance")
    assert r.status_code == 200
    body = r.json()
    # INSTANCE_NAME=rxf-test set in the fixture; defaults survive the round-trip.
    assert body["instance_name"] == "rxf-test"
    assert body["time_format"] in ("12h", "24h")


async def test_instance_put_persists_overrides(client):
    r = await client.put(
        "/api/instance",
        json={"instance_name": "rxf-prod", "time_format": "12h"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["instance_name"] == "rxf-prod"
    assert body["time_format"] == "12h"
    # Persisted across reads.
    again = (await client.get("/api/instance")).json()
    assert again["instance_name"] == "rxf-prod"
    assert again["time_format"] == "12h"


async def test_instance_put_rejects_blank_name(client):
    r = await client.put("/api/instance", json={"instance_name": "   "})
    assert r.status_code == 400


async def test_instance_put_rejects_bad_time_format(client):
    r = await client.put("/api/instance", json={"time_format": "48h"})
    assert r.status_code == 422  # pattern mismatch is a validation error


# ---- /api/notifications ---------------------------------------------------


async def test_ntfy_get_redacts_token(client):
    await accounts.set_app_setting("ntfy_base", "https://ntfy.example")
    await accounts.set_app_setting("ntfy_topic", "rxf")
    await accounts.set_app_setting("ntfy_token", "super-secret")

    r = await client.get("/api/notifications/ntfy")
    assert r.status_code == 200
    body = r.json()
    assert body["base"] == "https://ntfy.example"
    assert body["topic"] == "rxf"
    # CRITICAL: response must never carry the raw token.
    assert body["token_set"] is True
    assert "token" not in body or body.get("token") != "super-secret"


async def test_ntfy_put_empty_token_preserves_existing(client):
    await accounts.set_app_setting("ntfy_token", "keep-me")
    r = await client.put(
        "/api/notifications/ntfy",
        json={"base": "https://x", "topic": "t", "token": ""},
    )
    assert r.status_code == 200
    assert await accounts.get_app_setting("ntfy_token") == "keep-me"


async def test_smtp_get_redacts_password(client):
    await accounts.set_app_setting("smtp_password", "supersecret")
    r = await client.get("/api/notifications/smtp")
    assert r.status_code == 200
    body = r.json()
    assert body["password_set"] is True
    assert "password" not in body or body.get("password") != "supersecret"


async def test_ntfy_test_rejects_unconfigured(client):
    r = await client.post("/api/notifications/ntfy/test")
    assert r.status_code == 400


# ---- /api/backups (heatmap + storage-by-guest, the previously untested
#                   helpers) ---------------------------------------------


async def test_backups_endpoint_returns_summary(client, monkeypatch):
    from app.clients import pbs

    async def _fake_summary(_s):
        return BackupSummary(
            jobs=[],
            datastore=None,
            last_success_iso=None,
            success_today=0,
            total_today=0,
            reachable=True,
            error=None,
        )

    monkeypatch.setattr(pbs, "fetch_backup_summary", _fake_summary)

    r = await client.get("/api/backups")
    assert r.status_code == 200
    assert r.json()["reachable"] is True


async def test_heatmap_buckets_by_day(client, monkeypatch):
    from app.clients import pbs
    from app.models import BackupSnapshot

    async def _fake_summary(_s):
        return BackupSummary(
            jobs=[
                BackupSnapshot(
                    id="vm/100/2026-01-01",
                    target="vm/100",
                    backup_type="vm",
                    backup_id="100",
                    backup_time=1700000000,
                    size_b=1_000_000,
                    status="ok",
                    when_iso="2026-01-01T00:00:00Z",
                ),
                BackupSnapshot(
                    id="vm/100/2026-01-02",
                    target="vm/100",
                    backup_type="vm",
                    backup_id="100",
                    backup_time=1700086400,
                    size_b=2_000_000,
                    status="err",
                    when_iso="2026-01-02T00:00:00Z",
                ),
            ],
            datastore=None,
            last_success_iso=None,
            success_today=0,
            total_today=0,
            reachable=True,
            error=None,
        )

    monkeypatch.setattr(pbs, "fetch_backup_summary", _fake_summary)

    r = await client.get("/api/backups/heatmap?days=90")
    assert r.status_code == 200
    body = r.json()
    assert body["days"] == 90
    assert isinstance(body["cells"], list)


async def test_storage_by_guest_aggregates_size(client, monkeypatch):
    from app.clients import pbs
    from app.models import BackupSnapshot

    async def _fake_summary(_s):
        return BackupSummary(
            jobs=[
                BackupSnapshot(
                    id="vm/100/a",
                    target="vm/100",
                    backup_type="vm",
                    backup_id="100",
                    backup_time=1700000000,
                    size_b=1_000_000,
                    status="ok",
                    when_iso="2026-01-01T00:00:00Z",
                ),
                BackupSnapshot(
                    id="vm/100/b",
                    target="vm/100",
                    backup_type="vm",
                    backup_id="100",
                    backup_time=1700086400,
                    size_b=2_000_000,
                    status="ok",
                    when_iso="2026-01-02T00:00:00Z",
                ),
                BackupSnapshot(
                    id="ct/200/a",
                    target="ct/200",
                    backup_type="ct",
                    backup_id="200",
                    backup_time=1700172800,
                    size_b=500_000,
                    status="ok",
                    when_iso="2026-01-03T00:00:00Z",
                ),
            ],
            datastore=None,
            last_success_iso=None,
            success_today=0,
            total_today=0,
            reachable=True,
            error=None,
        )

    monkeypatch.setattr(pbs, "fetch_backup_summary", _fake_summary)

    r = await client.get("/api/backups/storage-by-guest")
    assert r.status_code == 200
    body = r.json()
    assert body["total_b"] == 3_500_000
    # Largest first: vm/100 (3M) before ct/200 (500K).
    assert body["items"][0]["target"] == "vm/100"
    assert body["items"][0]["size_b"] == 3_000_000
    assert body["items"][0]["count"] == 2
