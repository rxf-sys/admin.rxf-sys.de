from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..audit import record as audit_record
from ..auth import verify_cf_access
from ..cache import cache
from ..clients import pbs
from ..config import Settings, get_settings
from ..models import BackupSummary

router = APIRouter(prefix="/api/backups", tags=["backups"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=BackupSummary)
async def get_backups(settings: Settings = Depends(get_settings)) -> BackupSummary:
    async def loader() -> BackupSummary:
        return await pbs.fetch_backup_summary(settings)

    return await cache.get_or_set("backups", settings.cache_ttl_pbs, loader)


class VerifyRequest(BaseModel):
    backup_type: str
    backup_id: str
    backup_time: int


@router.post("/verify")
async def verify_snapshot(
    body: VerifyRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    claims: dict = Depends(verify_cf_access),
) -> dict:
    """Trigger a verify job for a single PBS snapshot.

    Requires the PBS API token to have ``Datastore.Verify`` on the datastore
    (``DatastoreAudit`` alone is read-only and will fail with 403).
    """
    if body.backup_type not in ("vm", "ct", "host"):
        raise HTTPException(status_code=400, detail="backup_type must be vm|ct|host")
    if not body.backup_id:
        raise HTTPException(status_code=400, detail="backup_id required")
    if body.backup_time <= 0:
        raise HTTPException(status_code=400, detail="backup_time must be a positive epoch")

    actor = claims.get("email") or claims.get("sub") or "unknown"
    audit_record(
        "pbs.verify",
        actor=actor,
        backup_type=body.backup_type,
        backup_id=body.backup_id,
        backup_time=body.backup_time,
        client_ip=request.client.host if request.client else None,
    )
    upid = await pbs.trigger_verify(settings, body.backup_type, body.backup_id, body.backup_time)
    audit_record(
        "pbs.verify.result",
        actor=actor,
        backup_id=body.backup_id,
        backup_time=body.backup_time,
        success=upid is not None,
        upid=upid,
    )
    if upid is None:
        raise HTTPException(
            status_code=502,
            detail="PBS verify trigger failed - token may lack Datastore.Verify",
        )
    # The summary cache is now stale; next read will refresh it.
    cache.invalidate("backups")
    return {"ok": True, "upid": upid}
