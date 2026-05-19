from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from .. import storage
from ..auth import verify_cf_access
from ..cache import cache
from ..clients import probes
from ..config import Settings, get_settings
from ..models import ServiceStatus

router = APIRouter(prefix="/api/services", tags=["services"], dependencies=[Depends(verify_cf_access)])


_KNOWN_IDS = {s["id"] for s in probes.SERVICES}


async def _enrich(s: ServiceStatus) -> ServiceStatus:
    """Attach rolled-up uptime / p95 / last_incident to a probe result.

    Each lookup hits SQLite locally, so we parallelise the three queries per
    service. Storage disabled (or no data yet) leaves the fields ``None``.
    """
    if not storage.is_enabled():
        return s
    uptime, p95, last_ts = await asyncio.gather(
        storage.uptime_pct(s.id, hours=720),  # 30 days
        storage.p95_ms(s.id, hours=24),
        storage.last_incident_ts(s.id),
    )
    last_iso = (
        datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat() if last_ts else None
    )
    return s.model_copy(
        update={"uptime_pct": uptime, "p95_ms": p95, "last_incident_iso": last_iso}
    )


@router.get("", response_model=list[ServiceStatus])
async def get_services(settings: Settings = Depends(get_settings)) -> list[ServiceStatus]:
    async def loader() -> list[ServiceStatus]:
        base = await probes.probe_all(settings)
        return list(await asyncio.gather(*(_enrich(s) for s in base)))

    return await cache.get_or_set("services", settings.cache_ttl_services, loader)


@router.get("/{service_id}/history")
async def get_service_history(service_id: str, hours: int = 24) -> dict:
    """Persisted probe samples for a single service. Returns ``samples``
    (oldest-first), an ``uptime_pct`` for the window, p95, and an ``enabled``
    flag so the UI can distinguish "history disabled" from "no data yet"."""
    if service_id not in _KNOWN_IDS:
        raise HTTPException(status_code=404, detail="unknown service id")
    hours = max(1, min(hours, 168))  # 7 days max
    samples, uptime, p95, last_ts = await asyncio.gather(
        storage.recent_probes(service_id, hours=hours),
        storage.uptime_pct(service_id, hours=hours),
        storage.p95_ms(service_id, hours=hours),
        storage.last_incident_ts(service_id),
    )
    return {
        "service_id": service_id,
        "hours": hours,
        "enabled": storage.is_enabled(),
        "uptime_pct": uptime,
        "p95_ms": p95,
        "last_incident_iso": (
            datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat() if last_ts else None
        ),
        "samples": samples,
    }
