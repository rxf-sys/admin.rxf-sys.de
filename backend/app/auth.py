"""Request authentication via local account sessions.

Replaces the former Cloudflare-Access JWT gate. Every protected router
depends on ``verify_session``; admin-only routes additionally depend on
``require_admin``.

When ``auth_enabled`` is False (local development) both dependencies resolve
to a synthetic admin identity so the API can be exercised without a login.
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException, Request, status

from . import accounts
from .config import Settings, get_settings

_DEV_USER: dict[str, Any] = {
    "id": 0,
    "username": "dev",
    "email": "dev@local",
    "role": "admin",
    "disabled": False,
    "created_at": 0,
    "last_login_at": None,
}


async def verify_session(request: Request) -> dict[str, Any]:
    """Resolve the session cookie OR an API bearer token to a user dict,
    or raise 401. The decoded user is also stashed on ``request.state.user``
    so downstream code (e.g. audit logging) can read it without re-querying.

    Bearer tokens take precedence — they're explicit, and a client that
    sends both probably intends to use the token.
    """
    settings: Settings = get_settings()
    if not settings.auth_enabled:
        request.state.user = _DEV_USER
        return _DEV_USER

    # Bearer token path (Authorization: Bearer rxf_…)
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        user = await accounts.resolve_api_token(auth.split(" ", 1)[1].strip())
        if user is not None:
            # Scope gate: a read-scoped token authenticates, but must never
            # mutate. Without this the scope field would be decorative — a
            # leaked "read" token could create users or mint admin tokens.
            if user.get("token_scope") == "read" and request.method not in (
                "GET",
                "HEAD",
                "OPTIONS",
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="API-Token mit Scope 'read' erlaubt nur Lesezugriffe",
                )
            request.state.user = user
            return user

    # Session cookie path
    token = request.cookies.get(settings.session_cookie_name, "")
    user = await accounts.resolve_session(token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        )
    request.state.user = user
    return user


async def require_admin(user: dict[str, Any] = Depends(verify_session)) -> dict[str, Any]:
    """Like ``verify_session`` but additionally requires the admin role.

    Token-authenticated requests must also carry an ``admin``-scoped token —
    a read/write token of an admin user is deliberately not enough for the
    account-management surface."""
    if user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="admin privileges required",
        )
    token_scope = user.get("token_scope")
    if token_scope is not None and token_scope != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API-Token-Scope 'admin' erforderlich",
        )
    return user


def require_role(*allowed_roles: str):
    """Dependency factory: returns a verify_session-like dep that also asserts
    the user's role is in ``allowed_roles``. Use for endpoints that should be
    open to operators but not viewers (e.g. audit run, service CRUD).
    """
    allowed = frozenset(allowed_roles)

    async def _dep(user: dict[str, Any] = Depends(verify_session)) -> dict[str, Any]:
        if user.get("role") not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires one of: {', '.join(sorted(allowed))}",
            )
        return user

    return _dep
