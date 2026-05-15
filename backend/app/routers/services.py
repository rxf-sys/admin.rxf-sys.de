from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import storage
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


_KNOWN_IDS = {s["id"] for s in probes.SERVICES}


@router.get("/{service_id}/history")
async def get_service_history(service_id: str, hours: int = 24) -> dict:
    """Persisted probe samples for a single service. Returns ``samples``
    (oldest-first), an ``uptime_pct`` for the window, and an ``enabled`` flag
    so the UI can distinguish "history disabled" from "no data yet"."""
    if service_id not in _KNOWN_IDS:
        raise HTTPException(status_code=404, detail="unknown service id")
    hours = max(1, min(hours, 168))  # 7 days max
    samples = await storage.recent_probes(service_id, hours=hours)
    uptime = await storage.uptime_pct(service_id, hours=hours)
    return {
        "service_id": service_id,
        "hours": hours,
        "enabled": storage.is_enabled(),
        "uptime_pct": uptime,
        "samples": samples,
    }
