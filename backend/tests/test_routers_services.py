"""End-to-end tests for the services CRUD router (/api/services)."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import registry
from app.config import get_settings
from app.routers import services as services_router


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "services-router.db")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    get_settings.cache_clear()
    registry.reset_for_tests(db)
    await registry.ensure_schema(get_settings())

    app = FastAPI()
    app.include_router(services_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    registry.reset_for_tests()
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
