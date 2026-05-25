"""HTTP endpoints driving the audit script runner. Admin-only."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from .. import auditor
from ..audit import record as audit_record
from ..auth import require_admin
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.post("/run", status_code=status.HTTP_202_ACCEPTED)
async def run_audit(
    request: Request,
    settings: Settings = Depends(get_settings),
    admin: dict = Depends(require_admin),
) -> dict:
    """Kick off the audit script asynchronously. Returns the new job id.

    Returns 409 ``audit already running`` when another run is in flight; the
    body's ``job_id`` then points to that ongoing run so the client can poll
    it.
    """
    actor = admin.get("email") or admin.get("username") or "unknown"
    try:
        job_id = await auditor.start_run(settings, started_by=actor)
    except auditor.AuditorBusy as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "audit already running", "job_id": str(e)},
        ) from e
    audit_record(
        "audit.started",
        actor=actor,
        job_id=job_id,
        client_ip=request.client.host if request.client else None,
    )
    return {"job_id": job_id}


@router.get("/jobs")
async def list_jobs(limit: int = 20, _: dict = Depends(require_admin)) -> dict:
    """Recent audit runs (newest first). ``log_output`` is omitted here —
    fetch a single job to get its full log."""
    return {
        "current_job_id": auditor.current_job(),
        "jobs": await auditor.list_runs(limit=limit),
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, _: dict = Depends(require_admin)) -> dict:
    """Detail of a single audit run, including the raw log."""
    run = await auditor.get_run(job_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job nicht gefunden")
    return run
