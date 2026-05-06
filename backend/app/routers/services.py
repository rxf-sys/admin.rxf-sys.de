from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import probes
from ..config import Settings, get_settings
from ..models import ServiceStatus

router = APIRouter(prefix="/api/services", tags=["services"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=list[ServiceStatus])
async def get_services(settings: Settings = Depends(get_settings)) -> list[ServiceStatus]:
    async def loader() -> list[ServiceStatus]:
        return await probes.probe_all(settings)

    return await cache.get_or_set("services", settings.cache_ttl_services, loader)
