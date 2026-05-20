from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import storage
from ..audit import record as audit_record
from ..auth import verify_session
from ..cache import cache
from ..clients import pbs, proxmox
from ..config import Settings, get_settings
from ..models import SystemSnapshot

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(verify_session)])


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
    claims: dict = Depends(verify_session),
) -> dict:
    if type not in ("lxc", "qemu", "ct", "vm"):
        raise HTTPException(status_code=400, detail="type must be lxc|qemu|ct|vm")
    actor = claims.get("email") or claims.get("username") or "unknown"
    audit_record(
        "guest.restart",
        actor=actor,
        vmid=vmid,
        guest_type=type,
        client_ip=request.client.host if request.client else None,
    )
    ok = await proxmox.restart_guest(settings, vmid, type)
    audit_record(
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


@router.get("/tasks/{upid}/log")
async def task_log(
    upid: str,
    settings: Settings = Depends(get_settings),
    limit: int = 200,
) -> dict:
    """Log lines for a single Proxmox task UPID."""
    lines = await proxmox.fetch_task_log(settings, upid, limit=min(max(limit, 1), 1000))
    return {"lines": lines}


@router.get("/guests/{vmid}/history")
async def guest_history(
    vmid: int,
    hours: int = 24,
) -> dict:
    """CPU + RAM time series for a single guest, sampled by the metrics loop.

    Returns an ``enabled`` flag so the UI can distinguish "history disabled"
    (storage off) from "no data yet" (loop just started). The PVE API doesn't
    expose its own history, so the rows come from our ``guest_metrics`` table.
    """
    hours = max(1, min(hours, 168))  # 7 day cap
    samples = await storage.guest_history(vmid, hours=hours)
    return {
        "vmid": vmid,
        "hours": hours,
        "enabled": storage.is_enabled(),
        "samples": samples,
    }


@router.get("/guests/{vmid}/backups")
async def guest_backups(
    vmid: int,
    limit: int = 5,
    settings: Settings = Depends(get_settings),
) -> dict:
    """Recent PBS snapshots whose ``backup-id`` matches this guest's VMID.

    PBS keys snapshots by ``backup-id`` (the guest's numeric ID for VM/CT
    backups), so we filter the existing backup summary rather than calling
    PBS again. Returned newest-first, capped at ``limit``.
    """
    limit = max(1, min(limit, 30))
    summary = await pbs.fetch_backup_summary(settings)
    vmid_str = str(vmid)
    matched = [j for j in summary.jobs if j.backup_id == vmid_str]
    matched.sort(key=lambda j: j.backup_time, reverse=True)
    return {
        "vmid": vmid,
        "limit": limit,
        "reachable": summary.reachable,
        "error": summary.error,
        "jobs": [j.model_dump() for j in matched[:limit]],
    }


@router.get("/guests/{vmid}/journal")
async def guest_journal(
    vmid: int,
    settings: Settings = Depends(get_settings),
    lastentries: int = 500,
) -> dict:
    """Host-journal entries that mention this VMID.

    NOTE: This is the host-side journal filtered for VMID references, not the
    guest's own ``journalctl`` (which the PVE API doesn't expose). It surfaces
    lifecycle events emitted by pveproxy / pve-container / pve-firewall.
    """
    lines = await proxmox.fetch_host_journal_for_vmid(
        settings, vmid, lastentries=min(max(lastentries, 50), 2000)
    )
    return {
        "vmid": vmid,
        "lines": lines,
        "note": "Host-Journal gefiltert nach VMID — kein Container-internes journalctl.",
    }
