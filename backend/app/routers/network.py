from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import unifi
from ..config import Settings, get_settings
from ..models import NetworkSnapshot

router = APIRouter(prefix="/api/network", tags=["network"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=NetworkSnapshot)
async def get_network(settings: Settings = Depends(get_settings)) -> NetworkSnapshot:
    async def loader() -> NetworkSnapshot:
        return await unifi.fetch_network_snapshot(settings)

    return await cache.get_or_set("network", settings.cache_ttl_unifi, loader)
