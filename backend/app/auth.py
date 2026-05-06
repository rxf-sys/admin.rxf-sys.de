from __future__ import annotations

import time

import httpx
from fastapi import HTTPException, Request, status
from jose import jwt
from jose.exceptions import JWTError

from .config import Settings, get_settings


class _JWKSCache:
    """Caches the Cloudflare Access JWKS for 1 hour."""

    def __init__(self) -> None:
        self._keys: dict | None = None
        self._fetched_at: float = 0.0

    async def get(self, team_domain: str) -> dict:
        if self._keys is not None and (time.time() - self._fetched_at) < 3600:
            return self._keys
        url = f"https://{team_domain}/cdn-cgi/access/certs"
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            self._keys = r.json()
            self._fetched_at = time.time()
        return self._keys


_jwks = _JWKSCache()


async def verify_cf_access(request: Request) -> dict:
    """Verifies the Cf-Access-Jwt-Assertion header.

    Returns the decoded claims. Raises 401 if invalid. If `auth_enabled`
    is False (dev), returns a stub identity.
    """
    settings: Settings = get_settings()
    if not settings.auth_enabled:
        return {"sub": "dev@local", "email": "dev@local", "aud": "dev"}

    token = request.headers.get("Cf-Access-Jwt-Assertion") or request.cookies.get("CF_Authorization")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing Cf-Access-Jwt-Assertion",
        )
    if not settings.cf_access_aud:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="cf_access_aud not configured",
        )

    try:
        jwks = await _jwks.get(settings.cf_access_team_domain)
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
        if key is None:
            raise HTTPException(status_code=401, detail="unknown signing key")

        claims = jwt.decode(
            token,
            key,
            algorithms=[unverified_header.get("alg", "RS256")],
            audience=settings.cf_access_aud,
            issuer=f"https://{settings.cf_access_team_domain}",
            options={"verify_at_hash": False},
        )
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"invalid token: {e}") from e

    return claims
