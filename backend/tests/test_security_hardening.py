"""Tests for the 2026-06 security-hardening round.

Covers: API-token scope enforcement (read = GET-only, admin gate, minting
ceiling), session rotation on re-login, FK cascade on user delete, the
production docs gate and the ntfy URL scheme validation.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import accounts
from app.config import get_settings
from app.routers import account as account_router
from app.routers import admin as admin_router
from app.routers import auth as auth_router
from app.routers import instance as instance_router
from app.routers import notifications as notifications_router


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "hardening.db")
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    get_settings.cache_clear()

    accounts.reset_for_tests(db)
    await accounts.ensure_schema(get_settings())
    await accounts.create_user("admin", "admin-password", role="admin")
    await accounts.create_user("bob", "bob-password", role="user")

    auth_router._fails.clear()

    app = FastAPI()
    app.include_router(auth_router.router)
    app.include_router(account_router.router)
    app.include_router(admin_router.router)
    app.include_router(instance_router.router)
    app.include_router(notifications_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    get_settings.cache_clear()


async def _login(client: httpx.AsyncClient, username: str, password: str) -> httpx.Response:
    return await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )


async def _make_token(username: str, scope: str) -> str:
    user = await accounts._get_user_row(username)  # noqa: SLF001 - test shortcut
    raw, _ = await accounts.create_api_token(int(user["id"]), f"t-{scope}", scope=scope)
    return raw


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Token scopes
# ---------------------------------------------------------------------------


async def test_read_token_can_get_but_not_mutate(client):
    token = await _make_token("bob", "read")
    r = await client.get("/api/account/settings", headers=_bearer(token))
    assert r.status_code == 200

    r = await client.put(
        "/api/account/settings", json={"settings": {"x": 1}}, headers=_bearer(token)
    )
    assert r.status_code == 403


async def test_read_token_cannot_mint_tokens(client):
    """Privilege escalation guard: a read token must not create new tokens."""
    token = await _make_token("bob", "read")
    r = await client.post(
        "/api/account/tokens",
        json={"name": "evil", "scope": "admin"},
        headers=_bearer(token),
    )
    assert r.status_code == 403


async def test_write_token_cannot_mint_higher_scope(client):
    token = await _make_token("bob", "write")
    escalate = await client.post(
        "/api/account/tokens",
        json={"name": "evil", "scope": "admin"},
        headers=_bearer(token),
    )
    assert escalate.status_code == 403

    same_scope = await client.post(
        "/api/account/tokens",
        json={"name": "ok", "scope": "write"},
        headers=_bearer(token),
    )
    assert same_scope.status_code == 201


async def test_write_token_of_admin_cannot_reach_admin_routes(client):
    """Admin surface needs an admin-scoped token — the owner's role alone is
    not enough when authenticating via API token."""
    token = await _make_token("admin", "write")
    r = await client.get("/api/admin/users", headers=_bearer(token))
    assert r.status_code == 403


async def test_admin_token_of_admin_reaches_admin_routes(client):
    token = await _make_token("admin", "admin")
    r = await client.get("/api/admin/users", headers=_bearer(token))
    assert r.status_code == 200


async def test_admin_token_of_non_admin_still_blocked(client):
    """Scope can't override role: bob with an admin-scoped token stays out."""
    token = await _make_token("bob", "admin")
    r = await client.get("/api/admin/users", headers=_bearer(token))
    assert r.status_code == 403


async def test_cookie_session_unaffected_by_scope_rules(client):
    await _login(client, "admin", "admin-password")
    r = await client.get("/api/admin/users")
    assert r.status_code == 200
    created = await client.post(
        "/api/account/tokens", json={"name": "cli", "scope": "admin"}
    )
    assert created.status_code == 201


# ---------------------------------------------------------------------------
# Session rotation on login
# ---------------------------------------------------------------------------


async def test_relogin_invalidates_previous_session(client):
    r1 = await _login(client, "bob", "bob-password")
    old_cookie = r1.cookies["rxf_session"]

    # Re-login from the same client (cookie jar still carries the old one).
    r2 = await _login(client, "bob", "bob-password")
    assert r2.status_code == 200
    assert r2.cookies["rxf_session"] != old_cookie

    # The superseded session row must be gone server-side.
    assert await accounts.resolve_session(old_cookie) is None
    sessions = await accounts.list_active_sessions()
    assert len(sessions) == 1


# ---------------------------------------------------------------------------
# FK cascade on user delete
# ---------------------------------------------------------------------------


async def test_delete_user_cascades_tokens_and_sessions(client):
    user = await accounts._get_user_row("bob")  # noqa: SLF001
    bob_id = int(user["id"])
    raw, _ = await accounts.create_api_token(bob_id, "bot", scope="read")
    await accounts.create_session(bob_id, ttl_hours=1)

    await accounts.delete_user(bob_id)

    assert await accounts.resolve_api_token(raw) is None
    assert await accounts.list_api_tokens(user_id=bob_id) == []
    assert all(s["user_id"] != bob_id for s in await accounts.list_active_sessions())


# ---------------------------------------------------------------------------
# Disabled accounts
# ---------------------------------------------------------------------------


async def test_disabled_account_cannot_authenticate(client):
    user = await accounts._get_user_row("bob")  # noqa: SLF001
    await accounts.update_user(int(user["id"]), disabled=True)
    assert await accounts.authenticate("bob", "bob-password") is None
    r = await _login(client, "bob", "bob-password")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Instance update audit trail
# ---------------------------------------------------------------------------


async def test_instance_update_writes_audit_event(client):
    from app import audit

    await _login(client, "admin", "admin-password")
    r = await client.put("/api/instance", json={"instance_name": "Neue Instanz"})
    assert r.status_code == 200
    assert "_" not in r.json()
    events = audit.recent(50)
    assert any(e.get("event") == "instance.updated" for e in events)


# ---------------------------------------------------------------------------
# ntfy URL validation
# ---------------------------------------------------------------------------


async def test_ntfy_base_requires_http_scheme(client):
    await _login(client, "admin", "admin-password")
    bad = await client.put(
        "/api/notifications/ntfy",
        json={"base": "gopher://intern", "topic": "t", "token": ""},
    )
    assert bad.status_code == 400

    ok = await client.put(
        "/api/notifications/ntfy",
        json={"base": "https://ntfy.example", "topic": "t", "token": ""},
    )
    assert ok.status_code == 200


# ---------------------------------------------------------------------------
# API docs are disabled in production
# ---------------------------------------------------------------------------


def test_docs_disabled_when_app_env_production():
    """app.main is imported without a .env in tests → app_env defaults to
    'production', so neither Swagger nor the OpenAPI schema may be mounted."""
    from app.main import _DOCS_ENABLED, app as main_app

    if _DOCS_ENABLED:
        pytest.skip("dev environment: docs intentionally enabled")
    assert main_app.docs_url is None
    assert main_app.openapi_url is None
    paths = {r.path for r in main_app.routes}
    assert "/api/docs" not in paths
    assert "/api/openapi.json" not in paths
