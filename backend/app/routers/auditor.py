"""HTTP endpoints driving the audit script runner. Admin-only."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .. import accounts, auditor
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
        # FastAPI passes ``detail`` straight through to JSON, so a dict here
        # makes the frontend's apiErrorMessage() render "[object Object]".
        # Keep the human message in ``detail`` and surface the running job
        # via an X-Running-Job-Id response header for clients that want to
        # poll the in-flight run instead of failing.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="audit already running",
            headers={"X-Running-Job-Id": str(e)},
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


# ---------------------------------------------------------------------------
# Auto-audit settings (background loop in main.py reads these on every tick)
# ---------------------------------------------------------------------------


class AutoAuditSettings(BaseModel):
    enabled: bool
    hour: int = Field(ge=0, le=23, description="Trigger hour in UTC, 0-23")


@router.get("/settings/auto", dependencies=[Depends(require_admin)])
async def get_auto_audit(settings: Settings = Depends(get_settings)) -> dict:
    """Effective auto-audit config (overrides + .env defaults)."""
    enabled = await accounts.get_app_setting("audit_auto_enabled")
    hour = await accounts.get_app_setting("audit_auto_hour")
    last_run = await accounts.get_app_setting("auto_audit_last_run_date")
    return {
        "enabled": (enabled == "true") if enabled is not None else settings.audit_auto_enabled,
        "hour": int(hour) if hour and hour.isdigit() else settings.audit_auto_hour,
        "last_run_date": last_run,
    }


@router.put("/settings/auto")
async def update_auto_audit(
    body: AutoAuditSettings, admin: dict = Depends(require_admin)
) -> dict:
    """Persist enabled + hour into app_settings. The background loop picks
    up the change on its next 5-minute tick — no restart needed."""
    await accounts.set_app_setting("audit_auto_enabled", "true" if body.enabled else "false")
    await accounts.set_app_setting("audit_auto_hour", str(body.hour))
    audit_record("audit.auto_settings_updated", actor=admin["username"], enabled=body.enabled, hour=body.hour)
    return {"enabled": body.enabled, "hour": body.hour}
