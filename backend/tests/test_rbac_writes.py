"""RBAC tests for write endpoints that must reject viewer-role users.

Pinned the gates added in the audit cleanup:
  * POST /api/system/guests/{vmid}/restart  → admin + operator
  * POST /api/backups/verify                 → admin + operator

Previously both were behind ``verify_session`` only, which meant a
read-only "viewer" account could disrupt running workloads / spam PBS
verify jobs."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import accounts
from app.cache import cache as system_cache
from app.config import get_settings
from app.routers import auth as auth_router
from app.routers import backups as backups_router
from app.routers import system as system_router


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "rbac.db")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    get_settings.cache_clear()

    accounts.reset_for_tests(db)
    await accounts.ensure_schema(get_settings())
    await accounts.create_user("admin", "admin-password", role="admin")
    await accounts.create_user("op", "op-password", role="operator")
    await accounts.create_user("viewer", "viewer-password", role="viewer")
    auth_router._fails.clear()
    system_cache.invalidate()

    app = FastAPI()
    app.include_router(auth_router.router)
    app.include_router(system_router.router)
    app.include_router(backups_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    get_settings.cache_clear()


async def _login(client: httpx.AsyncClient, username: str, password: str) -> None:
    r = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert r.status_code == 200, r.text


# ---- /api/system/guests/{vmid}/restart -----------------------------------


async def test_restart_blocked_for_viewer(client):
    await _login(client, "viewer", "viewer-password")
    r = await client.post("/api/system/guests/200/restart?type=lxc")
    assert r.status_code == 403
    assert "requires" in r.json()["detail"].lower()


async def test_restart_allowed_for_operator(client, monkeypatch):
    # The upstream call would talk to PVE; stub it so the gate is what we test.
    from app.clients import proxmox

    async def _fake_restart(*_a, **_kw):
        return True

    monkeypatch.setattr(proxmox, "restart_guest", _fake_restart)

    await _login(client, "op", "op-password")
    r = await client.post("/api/system/guests/200/restart?type=lxc")
    assert r.status_code == 200
    assert r.json()["ok"] is True


async def test_restart_allowed_for_admin(client, monkeypatch):
    from app.clients import proxmox

    async def _fake_restart(*_a, **_kw):
        return True

    monkeypatch.setattr(proxmox, "restart_guest", _fake_restart)

    await _login(client, "admin", "admin-password")
    r = await client.post("/api/system/guests/100/restart?type=qemu")
    assert r.status_code == 200


async def test_restart_rejects_unknown_type(client):
    await _login(client, "admin", "admin-password")
    r = await client.post("/api/system/guests/100/restart?type=docker")
    assert r.status_code == 400


# ---- /api/backups/verify -------------------------------------------------


async def test_verify_blocked_for_viewer(client):
    await _login(client, "viewer", "viewer-password")
    r = await client.post(
        "/api/backups/verify",
        json={"backup_type": "vm", "backup_id": "100", "backup_time": 1},
    )
    assert r.status_code == 403


async def test_verify_allowed_for_operator(client, monkeypatch):
    from app.clients import pbs

    async def _fake_trigger(*_a, **_kw):
        return "UPID:rxf:0:0:0:0:0:verify::"

    monkeypatch.setattr(pbs, "trigger_verify", _fake_trigger)

    await _login(client, "op", "op-password")
    r = await client.post(
        "/api/backups/verify",
        json={"backup_type": "vm", "backup_id": "100", "backup_time": 1700000000},
    )
    assert r.status_code == 200
    assert r.json()["upid"].startswith("UPID:")


async def test_verify_validates_backup_type(client, monkeypatch):
    from app.clients import pbs

    async def _fake_trigger(*_a, **_kw):
        return "UPID:x"

    monkeypatch.setattr(pbs, "trigger_verify", _fake_trigger)

    await _login(client, "admin", "admin-password")
    r = await client.post(
        "/api/backups/verify",
        json={"backup_type": "snapshot", "backup_id": "100", "backup_time": 1},
    )
    assert r.status_code == 400
