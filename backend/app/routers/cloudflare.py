"""Cloudflare-specific endpoints beyond Tunnel + Certs.

Currently exposes the Access audit-log so the dashboard can show the last
login + 24h session count. The Cloudflare API token configured for this
backend needs the "Access: Apps and Policies: Read" permission (read on
the account-level Access scope) for this to work — without it the call
returns 403 and we surface ``reachable=false`` rather than 5xx.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import cloudflare
from ..config import Settings, get_settings

router = APIRouter(
    prefix="/api/cloudflare", tags=["cloudflare"], dependencies=[Depends(verify_cf_access)]
)


@router.get("/access/sessions")
async def get_access_sessions(
    hours: int = 24, limit: int = 100, settings: Settings = Depends(get_settings)
) -> dict:
    hours = max(1, min(hours, 168))
    limit = max(1, min(limit, 500))

    async def loader() -> dict:
        return await cloudflare.fetch_access_sessions(settings, hours=hours, limit=limit)

    return await cache.get_or_set(
        f"cf-access-sessions:{hours}:{limit}", 300, loader
    )
