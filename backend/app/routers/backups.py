from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..audit import record as audit_record
from ..auth import verify_session
from ..cache import cache
from ..clients import pbs
from ..config import Settings, get_settings
from ..models import BackupSummary

router = APIRouter(prefix="/api/backups", tags=["backups"], dependencies=[Depends(verify_session)])


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
    claims: dict = Depends(verify_session),
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

    actor = claims.get("email") or claims.get("username") or "unknown"
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


@router.get("/heatmap")
async def get_heatmap(days: int = 30, settings: Settings = Depends(get_settings)) -> dict:
    """Per-day success/partial/error counts over the last N days.

    Counts are derived from the existing PBS snapshot summary — no extra call
    to PBS. Each day cell is one of: ``empty`` (no backups), ``ok`` (all
    snapshots that day verified or pending), ``partial`` (mix of ok and
    failed), or ``err`` (only failed). The percentages let the UI pick
    a colour shade per cell.

    Note: only as far back as PBS's retention policy keeps snapshots; if your
    PBS prunes after 14 days the older buckets will be ``empty``.
    """
    days = max(1, min(days, 90))
    summary = await pbs.fetch_backup_summary(settings)
    today = datetime.now(timezone.utc).date()
    buckets: dict[str, dict[str, int]] = {}
    for i in range(days):
        d = (today - timedelta(days=i)).isoformat()
        buckets[d] = {"ok": 0, "warn": 0, "err": 0}
    success_total = 0
    fail_total = 0
    for j in summary.jobs:
        d = datetime.fromtimestamp(j.backup_time, tz=timezone.utc).date().isoformat()
        if d not in buckets:
            continue
        key = "ok" if j.status == "ok" else ("warn" if j.status == "warn" else "err")
        buckets[d][key] += 1
        if j.status == "ok":
            success_total += 1
        else:
            fail_total += 1
    cells: list[dict] = []
    for d in sorted(buckets.keys()):
        b = buckets[d]
        total = b["ok"] + b["warn"] + b["err"]
        if total == 0:
            label = "empty"
        elif b["err"] == 0 and b["warn"] == 0:
            label = "ok"
        elif b["ok"] > 0:
            label = "partial"
        else:
            label = "err"
        cells.append({"day": d, "label": label, **b, "total": total})
    overall = success_total + fail_total
    pct = round((success_total / overall) * 100, 1) if overall else None
    return {
        "days": days,
        "reachable": summary.reachable,
        "error": summary.error,
        "success_pct": pct,
        "cells": cells,
    }


@router.get("/storage-by-guest")
async def get_storage_by_guest(settings: Settings = Depends(get_settings)) -> dict:
    """Total snapshot size per backup-id, summed across the retained window.

    PBS doesn't expose dedup-aware sizes via the snapshot list, so this is the
    raw sum of ``size`` per ``backup-id`` (the guest's VMID for ct/vm
    backups). Returned sorted largest-first.
    """
    summary = await pbs.fetch_backup_summary(settings)
    per: dict[str, dict] = {}
    for j in summary.jobs:
        key = f"{j.backup_type}/{j.backup_id}"
        entry = per.setdefault(
            key,
            {
                "target": key,
                "backup_type": j.backup_type,
                "backup_id": j.backup_id,
                "size_b": 0,
                "count": 0,
            },
        )
        entry["size_b"] += int(j.size_b)
        entry["count"] += 1
    items = sorted(per.values(), key=lambda x: x["size_b"], reverse=True)
    total = sum(int(x["size_b"]) for x in items)
    return {
        "reachable": summary.reachable,
        "error": summary.error,
        "total_b": total,
        "items": items,
    }
