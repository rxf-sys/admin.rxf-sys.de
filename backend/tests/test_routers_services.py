"""End-to-end tests for the services CRUD router (/api/services)."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import registry
from app.config import get_settings
from app.models import ServiceStatus
from app.routers import services as services_router
from app.state import service_snapshot


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "services-router.db")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    get_settings.cache_clear()
    registry.reset_for_tests(db)
    await registry.ensure_schema(get_settings())
    # Each test starts with a clean snapshot so request_refresh signals from
    # CRUD operations don't leak across tests.
    service_snapshot.reset_for_tests()

    app = FastAPI()
    app.include_router(services_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    registry.reset_for_tests()
    service_snapshot.reset_for_tests()
    get_settings.cache_clear()


async def test_create_validates_url_scheme(client):
    r = await client.post(
        "/api/services",
        json={"name": "bad", "internal_url": "ftp://example"},
    )
    assert r.status_code == 400


async def test_crud_roundtrip(client):
    # Create
    r = await client.post(
        "/api/services",
        json={
            "name": "Grafana",
            "internal_url": "http://192.168.2.50:3000",
            "icon": "monitor",
            "desc": "Dashboards",
        },
    )
    assert r.status_code == 201
    svc = r.json()["service"]
    assert svc["id"].startswith("custom-")
    sid = svc["id"]

    # Patch
    r = await client.patch(f"/api/services/{sid}", json={"name": "Grafana v2"})
    assert r.status_code == 200
    assert r.json()["service"]["name"] == "Grafana v2"

    # Delete + re-delete (404)
    assert (await client.delete(f"/api/services/{sid}")).status_code == 200
    assert (await client.delete(f"/api/services/{sid}")).status_code == 404


async def test_patch_unknown_service_returns_404(client):
    r = await client.patch("/api/services/custom-deadbeef", json={"name": "x"})
    assert r.status_code == 404


async def test_history_unknown_service_returns_404(client):
    # No services in this registry — every id is unknown.
    r = await client.get("/api/services/vault/history")
    assert r.status_code == 404


async def test_get_services_reads_snapshot_without_probing(client, monkeypatch):
    """When the snapshot has data, GET must return it without calling probe_all."""
    sentinel = ServiceStatus(
        id="from-snapshot",
        name="from-snapshot",
        sub="",
        icon="cloud",
        desc="",
        status="ok",
        ms=42,
    )
    await service_snapshot.set([sentinel])

    async def fail_probe(_settings):  # pragma: no cover - must not be called
        raise AssertionError("probe_all should not run when snapshot is warm")

    monkeypatch.setattr(services_router.probes, "probe_all", fail_probe)

    r = await client.get("/api/services")
    assert r.status_code == 200
    body = r.json()
    assert [s["id"] for s in body] == ["from-snapshot"]
    assert body[0]["ms"] == 42


async def test_get_services_cold_snapshot_falls_back_to_probe(client, monkeypatch):
    """Cold snapshot (loop disabled / first request) inlines a probe once."""
    seeded = ServiceStatus(
        id="cold-probe",
        name="cold-probe",
        sub="",
        icon="cloud",
        desc="",
        status="ok",
        ms=7,
    )

    async def fake_probe(_settings):
        return [seeded]

    monkeypatch.setattr(services_router.probes, "probe_all", fake_probe)

    r = await client.get("/api/services")
    assert r.status_code == 200
    body = r.json()
    assert [s["id"] for s in body] == ["cold-probe"]

    # After the cold-start fallback the snapshot must be populated.
    cached, _ = await service_snapshot.get()
    assert cached is not None and [c.id for c in cached] == ["cold-probe"]


async def test_crud_signals_snapshot_refresh(client):
    """POST / PATCH / DELETE must request a probe refresh on the snapshot."""
    # Start from a clean slate so the event flag is unambiguous.
    service_snapshot._refresh.clear()
    r = await client.post(
        "/api/services",
        json={"name": "Refresh", "internal_url": "http://192.168.2.99"},
    )
    assert r.status_code == 201
    assert service_snapshot._refresh.is_set()
