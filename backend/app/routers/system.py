from __future__ import annotations

import asyncio
import time

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import proxmox
from ..config import Settings, get_settings
from ..models import SystemSnapshot

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(verify_cf_access)])
audit_log = structlog.get_logger("audit")


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
    request: Request,
    type: str = "lxc",
    settings: Settings = Depends(get_settings),
    claims: dict = Depends(verify_cf_access),
) -> dict:
    if type not in ("lxc", "qemu", "ct", "vm"):
        raise HTTPException(status_code=400, detail="type must be lxc|qemu|ct|vm")
    actor = claims.get("email") or claims.get("sub") or "unknown"
    audit_log.info(
        "guest.restart",
        actor=actor,
        vmid=vmid,
        guest_type=type,
        client_ip=request.client.host if request.client else None,
    )
    ok = await proxmox.restart_guest(settings, vmid, type)
    audit_log.info(
        "guest.restart.result", actor=actor, vmid=vmid, guest_type=type, success=ok
    )
    cache.invalidate("system")
    return {"ok": ok}


@router.get("/guests/{vmid}/tasks")
async def guest_tasks(
    vmid: int,
    settings: Settings = Depends(get_settings),
    limit: int = 10,
) -> dict:
    """Recent Proxmox tasks for a specific guest (UPID, status, time)."""
    tasks = await proxmox.fetch_guest_tasks(settings, vmid, limit=min(max(limit, 1), 50))
    return {"tasks": tasks}
