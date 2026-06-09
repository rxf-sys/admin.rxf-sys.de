"""End-to-end tests for the login / account / admin HTTP endpoints."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import accounts
from app.config import get_settings
from app.routers import account as account_router
from app.routers import admin as admin_router
from app.routers import auth as auth_router


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "auth.db")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    get_settings.cache_clear()

    accounts.reset_for_tests(db)
    await accounts.ensure_schema(get_settings())
    await accounts.create_user("admin", "admin-password", role="admin")
    await accounts.create_user("bob", "bob-password", role="user")

    # Reset the login rate-limiter between tests.
    auth_router._fails.clear()

    app = FastAPI()
    app.include_router(auth_router.router)
    app.include_router(account_router.router)
    app.include_router(admin_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    get_settings.cache_clear()


async def _login(client: httpx.AsyncClient, username: str, password: str) -> httpx.Response:
    return await client.post("/api/auth/login", json={"username": username, "password": password})


async def test_login_wrong_password_rejected(client):
    r = await _login(client, "admin", "nope")
    assert r.status_code == 401


async def test_login_sets_session_cookie(client):
    r = await _login(client, "admin", "admin-password")
    assert r.status_code == 200
    assert r.json()["user"]["username"] == "admin"
    assert "rxf_session" in r.cookies


async def test_me_requires_authentication(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
    await _login(client, "bob", "bob-password")
    r = await client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["user"]["username"] == "bob"


async def test_logout_invalidates_session(client):
    await _login(client, "bob", "bob-password")
    assert (await client.get("/api/auth/me")).status_code == 200
    await client.post("/api/auth/logout")
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_account_settings_roundtrip(client):
    await _login(client, "bob", "bob-password")
    assert (await client.get("/api/account/settings")).json()["settings"] == {}
    r = await client.put("/api/account/settings", json={"settings": {"theme": "light"}})
    assert r.status_code == 200
    assert (await client.get("/api/account/settings")).json()["settings"] == {"theme": "light"}


async def test_change_password_requires_current(client):
    await _login(client, "bob", "bob-password")
    bad = await client.post(
        "/api/account/password",
        json={"current_password": "wrong", "new_password": "new-password"},
    )
    assert bad.status_code == 403
    ok = await client.post(
        "/api/account/password",
        json={"current_password": "bob-password", "new_password": "new-password"},
    )
    assert ok.status_code == 200
    assert await accounts.authenticate("bob", "new-password") is not None


async def test_admin_can_list_and_create_users(client):
    await _login(client, "admin", "admin-password")
    listing = await client.get("/api/admin/users")
    assert listing.status_code == 200
    assert {u["username"] for u in listing.json()["users"]} == {"admin", "bob"}

    created = await client.post(
        "/api/admin/users",
        json={"username": "carol", "password": "carol-password", "role": "user"},
    )
    assert created.status_code == 201
    assert created.json()["user"]["username"] == "carol"


async def test_non_admin_cannot_reach_admin_routes(client):
    await _login(client, "bob", "bob-password")
    r = await client.get("/api/admin/users")
    assert r.status_code == 403


async def test_last_admin_cannot_be_deleted(client):
    await _login(client, "admin", "admin-password")
    users = (await client.get("/api/admin/users")).json()["users"]
    admin_id = next(u["id"] for u in users if u["username"] == "admin")
    r = await client.request("DELETE", f"/api/admin/users/{admin_id}")
    # Deleting yourself is blocked first (409).
    assert r.status_code == 409


async def test_admin_can_delete_other_user(client):
    await _login(client, "admin", "admin-password")
    users = (await client.get("/api/admin/users")).json()["users"]
    bob_id = next(u["id"] for u in users if u["username"] == "bob")
    r = await client.request("DELETE", f"/api/admin/users/{bob_id}")
    assert r.status_code == 200
    assert await accounts.get_user_by_id(bob_id) is None


async def test_login_rate_limited_after_repeated_failures(client):
    for _ in range(5):
        await _login(client, "admin", "wrong")
    r = await _login(client, "admin", "admin-password")
    assert r.status_code == 429


# ---- Proxy-aware rate-limit IP extraction ---------------------------------

async def test_rate_limit_keys_off_socket_when_proxy_untrusted(client, monkeypatch):
    """Default config: header is ignored, so two clients with different
    X-Forwarded-For values still share the per-socket bucket."""
    auth_router._fails.clear()
    for _ in range(5):
        # Each attempt claims to be a different "real" client via the header;
        # without trust_proxy_headers the rate limit must still trip.
        await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "wrong"},
            headers={"X-Forwarded-For": f"10.0.0.{_}"},
        )
    r = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin-password"},
        headers={"X-Forwarded-For": "10.0.0.99"},
    )
    assert r.status_code == 429


async def test_rate_limit_uses_forwarded_header_when_proxy_trusted(client, monkeypatch):
    """With trust_proxy_headers=true, each X-Forwarded-For value gets its
    own bucket so one bad client can't lock out everyone behind the proxy."""
    auth_router._fails.clear()
    monkeypatch.setenv("TRUST_PROXY_HEADERS", "true")
    get_settings.cache_clear()
    try:
        # 5 fails as 10.0.0.1 — trips the limit for that IP only.
        for _ in range(5):
            await client.post(
                "/api/auth/login",
                json={"username": "admin", "password": "wrong"},
                headers={"X-Forwarded-For": "10.0.0.1"},
            )
        blocked = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin-password"},
            headers={"X-Forwarded-For": "10.0.0.1"},
        )
        assert blocked.status_code == 429

        # A different forwarded IP starts with a fresh bucket.
        ok = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin-password"},
            headers={"X-Forwarded-For": "10.0.0.2"},
        )
        assert ok.status_code == 200
    finally:
        get_settings.cache_clear()


async def test_cf_connecting_ip_header_takes_precedence(client, monkeypatch):
    auth_router._fails.clear()
    monkeypatch.setenv("TRUST_PROXY_HEADERS", "true")
    get_settings.cache_clear()
    try:
        for _ in range(5):
            await client.post(
                "/api/auth/login",
                json={"username": "admin", "password": "wrong"},
                headers={"CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "5.6.7.8"},
            )
        # Still blocked when CF-Connecting-IP matches, even though XFF differs.
        blocked = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin-password"},
            headers={"CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "9.9.9.9"},
        )
        assert blocked.status_code == 429
    finally:
        get_settings.cache_clear()
