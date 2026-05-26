"""End-to-end tests for the system router (/api/system/*)."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import registry
from app.cache import cache as system_cache
from app.config import get_settings
from app.routers import system as system_router


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "system-router.db")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    get_settings.cache_clear()
    registry.reset_for_tests(db)
    await registry.ensure_schema(get_settings())
    system_cache.invalidate()

    app = FastAPI()
    app.include_router(system_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    registry.reset_for_tests()
    get_settings.cache_clear()


async def test_set_guest_service_label_persists(client):
    r = await client.patch(
        "/api/system/guests/201/service",
        json={"service": "Proxmox Backup"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "vmid": 201, "service": "Proxmox Backup"}
    labels = await registry.list_guest_labels()
    assert labels == {201: "Proxmox Backup"}


async def test_set_empty_service_clears_label(client):
    await registry.set_guest_label(201, "old", updated_by="tester")
    r = await client.patch("/api/system/guests/201/service", json={"service": ""})
    assert r.status_code == 200
    assert r.json()["service"] is None
    assert await registry.list_guest_labels() == {}


async def test_set_whitespace_only_label_is_treated_as_clear(client):
    r = await client.patch("/api/system/guests/201/service", json={"service": "   "})
    assert r.status_code == 200
    assert await registry.list_guest_labels() == {}


async def test_restart_rejects_bad_type(client):
    r = await client.post("/api/system/guests/123/restart?type=bogus")
    assert r.status_code == 400
