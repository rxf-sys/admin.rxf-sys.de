from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import cloudflare
from ..config import Settings, get_settings
from ..models import TunnelStatus

router = APIRouter(prefix="/api/tunnel", tags=["tunnel"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=TunnelStatus)
async def get_tunnel(settings: Settings = Depends(get_settings)) -> TunnelStatus:
    async def loader() -> TunnelStatus:
        tunnel, wan_ip = await asyncio.gather(
            cloudflare.fetch_tunnel_status(settings),
            cloudflare.fetch_wan_ip(),
        )
        tunnel.wan_ip = wan_ip
        return tunnel

    return await cache.get_or_set("tunnel", settings.cache_ttl_tunnel, loader)
