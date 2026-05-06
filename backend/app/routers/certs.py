from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import cloudflare
from ..config import Settings, get_settings
from ..models import CertsSnapshot

router = APIRouter(prefix="/api/certs", tags=["certs"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=CertsSnapshot)
async def get_certs(settings: Settings = Depends(get_settings)) -> CertsSnapshot:
    async def loader() -> CertsSnapshot:
        certs, dns = await asyncio.gather(
            cloudflare.fetch_certs(settings),
            cloudflare.fetch_dns_consistency(settings),
        )
        return CertsSnapshot(certs=certs, dns=dns)

    return await cache.get_or_set("certs", settings.cache_ttl_certs, loader)
