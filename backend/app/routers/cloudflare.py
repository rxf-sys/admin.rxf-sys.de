"""Cloudflare-specific endpoints beyond Tunnel + Certs.

Currently exposes the Access audit-log so the dashboard can show the last
login + 24h session count. The Cloudflare API token configured for this
backend needs the "Access: Apps and Policies: Read" permission (read on
the account-level Access scope) for this to work — without it the call
returns 403 and we surface ``reachable=false`` rather than 5xx.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import verify_session
from ..cache import cache
from ..clients import cloudflare
from ..config import Settings, get_settings

router = APIRouter(
    prefix="/api/cloudflare", tags=["cloudflare"], dependencies=[Depends(verify_session)]
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


@router.get("/analytics")
async def get_zone_analytics(
    minutes: int = 60, settings: Settings = Depends(get_settings)
) -> dict:
    """Aggregated zone analytics (requests, cache-hit, threats) over the last
    ``minutes`` — drives the Requests card on the Cloudflare tab.

    Cached for ``cache_ttl_cf_analytics`` seconds (default 5 min) since the
    dashboard endpoint updates roughly once per minute upstream and isn't
    worth hammering on every poll."""
    minutes = max(5, min(minutes, 1440))

    async def loader() -> dict:
        return await cloudflare.fetch_zone_analytics(settings, minutes=minutes)

    return await cache.get_or_set(
        f"cf-analytics:{minutes}", settings.cache_ttl_cf_analytics, loader
    )
