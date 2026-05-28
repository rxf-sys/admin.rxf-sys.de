from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .. import registry, storage
from ..audit import record as audit_record
from ..auth import require_admin, verify_session
from ..clients import probes
from ..config import Settings, get_settings
from ..models import ServiceStatus
from ..state import service_snapshot

router = APIRouter(prefix="/api/services", tags=["services"], dependencies=[Depends(verify_session)])


async def _is_known_service(service_id: str) -> bool:
    """A service id is valid if it maps to a registered service."""
    return await registry.get_service(service_id) is not None


class ServiceCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    internal_url: str = Field(min_length=1, max_length=500)
    icon: str = Field(default="cloud", max_length=40)
    desc: str = Field(default="", max_length=200)
    ext_url: str | None = Field(default=None, max_length=500)


class ServiceUpdateBody(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    internal_url: str | None = Field(default=None, max_length=500)
    icon: str | None = Field(default=None, max_length=40)
    desc: str | None = Field(default=None, max_length=200)
    ext_url: str | None = Field(default=None, max_length=500)


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
    """Return the latest probe snapshot, enriched with persisted rollups.

    Reads only the in-memory snapshot maintained by the background probe
    loop in main.py — never triggers an inline probe. If the snapshot is
    cold (loop disabled, or first tick still running) we fall back to a
    one-shot probe so the API stays useful in tests and during the very
    first request after startup."""
    results, _ = await service_snapshot.get()
    if results is None:
        results = await probes.probe_all(settings)
        await service_snapshot.set(results)
    return list(await asyncio.gather(*(_enrich(s) for s in results)))


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_service(
    body: ServiceCreateBody,
    request: Request,
    admin: dict = Depends(require_admin),
) -> dict:
    """Register a new custom service for monitoring (admin only)."""
    actor = admin.get("email") or admin.get("username") or "unknown"
    try:
        svc = await registry.create_service(
            name=body.name,
            internal_url=body.internal_url,
            icon=body.icon,
            desc=body.desc,
            ext_url=body.ext_url,
            created_by=actor,
        )
    except registry.RegistryError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    audit_record(
        "service.created",
        actor=actor,
        service_id=svc["id"],
        name=svc["name"],
        client_ip=request.client.host if request.client else None,
    )
    service_snapshot.request_refresh()
    return {"service": svc}


@router.patch("/{service_id}")
async def update_service(
    service_id: str,
    body: ServiceUpdateBody,
    admin: dict = Depends(require_admin),
) -> dict:
    """Edit a registered service (admin only)."""
    try:
        svc = await registry.update_service(
            service_id,
            name=body.name,
            internal_url=body.internal_url,
            icon=body.icon,
            desc=body.desc,
            ext_url=body.ext_url,
        )
    except registry.RegistryError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    if svc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service nicht gefunden")
    audit_record(
        "service.updated", actor=admin["username"], service_id=service_id
    )
    service_snapshot.request_refresh()
    return {"service": svc}


@router.delete("/{service_id}")
async def delete_service(
    service_id: str,
    admin: dict = Depends(require_admin),
) -> dict:
    """Delete a registered service (admin only)."""
    ok = await registry.delete_service(service_id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service nicht gefunden")
    audit_record(
        "service.deleted", actor=admin["username"], service_id=service_id
    )
    service_snapshot.request_refresh()
    return {"ok": True}


@router.get("/{service_id}/history")
async def get_service_history(service_id: str, hours: int = 24) -> dict:
    """Persisted probe samples for a single service. Returns ``samples``
    (oldest-first), an ``uptime_pct`` for the window, p95, and an ``enabled``
    flag so the UI can distinguish "history disabled" from "no data yet"."""
    if not await _is_known_service(service_id):
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
