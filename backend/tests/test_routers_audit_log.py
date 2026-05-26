"""End-to-end tests for the audit event-log router (/api/audit, /api/events)."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import audit as audit_buffer
from app.config import get_settings
from app.routers import audit as audit_router


@pytest.fixture
async def client(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    get_settings.cache_clear()
    audit_buffer.clear()

    app = FastAPI()
    app.include_router(audit_router.router)
    app.include_router(audit_router.events_router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    get_settings.cache_clear()
    audit_buffer.clear()


async def test_recent_events_returned_newest_first(client):
    audit_buffer.record("test.first", actor="alice")
    audit_buffer.record("test.second", actor="bob")
    r = await client.get("/api/audit")
    assert r.status_code == 200
    events = r.json()["events"]
    assert [e["event"] for e in events] == ["test.second", "test.first"]


async def test_events_alias_returns_same_data(client):
    audit_buffer.record("test.event", actor="alice")
    a = await client.get("/api/audit")
    b = await client.get("/api/events")
    assert a.status_code == 200 and b.status_code == 200
    assert a.json() == b.json()


async def test_limit_is_clamped(client):
    for i in range(5):
        audit_buffer.record(f"test.{i}")
    r = await client.get("/api/audit?limit=2")
    assert r.status_code == 200
    assert len(r.json()["events"]) == 2
    # Out-of-range limits get clamped, not rejected.
    r = await client.get("/api/audit?limit=99999")
    assert r.status_code == 200
