from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import proxmox
from ..config import Settings, get_settings
from ..models import SystemSnapshot

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=SystemSnapshot)
async def get_system(settings: Settings = Depends(get_settings)) -> SystemSnapshot:
    async def loader() -> SystemSnapshot:
        host, guests, datastores = await asyncio.gather(
            proxmox.fetch_host_status(settings),
            proxmox.fetch_guests(settings),
            proxmox.fetch_datastores(settings),
        )
        return SystemSnapshot(host=host, guests=guests, datastores=datastores, fetched_at=time.time())

    return await cache.get_or_set("system", settings.cache_ttl_system, loader)


@router.post("/guests/{vmid}/restart")
async def restart(
    vmid: int,
    type: str = "lxc",
    settings: Settings = Depends(get_settings),
) -> dict:
    if type not in ("lxc", "qemu", "ct", "vm"):
        raise HTTPException(status_code=400, detail="type must be lxc|qemu|ct|vm")
    ok = await proxmox.restart_guest(settings, vmid, type)
    cache.invalidate("system")
    return {"ok": ok}
