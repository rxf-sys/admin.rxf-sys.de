from __future__ import annotations

from datetime import datetime, timezone

import httpx
import structlog

from ..config import Settings
from ..models import BackupSnapshot, BackupSummary, Datastore

log = structlog.get_logger("pbs")


def _auth_header(settings: Settings) -> dict[str, str]:
    return {
        "Authorization": f"PBSAPIToken={settings.pbs_token_id}:{settings.pbs_token_secret}",
    }


def _base_url(settings: Settings) -> str:
    return f"https://{settings.pbs_host}:{settings.pbs_port}/api2/json"


async def _get(client: httpx.AsyncClient, settings: Settings, path: str) -> list | dict:
    r = await client.get(f"{_base_url(settings)}{path}", headers=_auth_header(settings))
    r.raise_for_status()
    return r.json().get("data", [])


def _verify_status(verification: dict | None) -> str:
    """Map PBS verification.state to our four-state UI value.

    PBS exposes (per pbs-docs): ``ok`` / ``failed`` / ``none`` (never verified)
    and ``old``/``outdated`` (verified, but the verify-job's ``outdated-after``
    has elapsed since). We surface stale verifications as ``pending`` so the
    dashboard nudges the operator to re-verify, rather than masking them as
    "unknown" alongside completely unverified backups.
    """
    if not verification:
        return "—"
    state = (verification.get("state") or "").lower()
    if state in ("ok", "success"):
        return "ok"
    if state in ("queued", "running", "old", "outdated"):
        return "pending"
    if state in ("failed", "error"):
        return "failed"
    return "—"


async def trigger_verify(
    settings: Settings, backup_type: str, backup_id: str, backup_time: int
) -> str | None:
    """Kick off a verification job for a single PBS snapshot.

    Returns the resulting UPID on success, ``None`` on error. The token needs
    the ``Datastore.Verify`` privilege on the datastore — ``DatastoreAudit``
    alone (the default for read-only dashboards) is not sufficient.
    """
    if not (settings.pbs_token_id and settings.pbs_token_secret):
        return None
    payload = {
        "backup-type": backup_type,
        "backup-id": backup_id,
        "backup-time": backup_time,
    }
    async with httpx.AsyncClient(verify=settings.pbs_verify_tls, timeout=10.0) as client:
        try:
            r = await client.post(
                f"{_base_url(settings)}/admin/datastore/{settings.pbs_datastore}/verify",
                headers={**_auth_header(settings), "Content-Type": "application/json"},
                json=payload,
            )
            r.raise_for_status()
        except httpx.HTTPError as e:
            log.warning(
                "pbs.verify_trigger_failed",
                backup_type=backup_type,
                backup_id=backup_id,
                backup_time=backup_time,
                error=str(e),
                error_type=type(e).__name__,
            )
            return None
        try:
            data = r.json().get("data")
        except ValueError:
            data = None
        if isinstance(data, str) and data.startswith("UPID:"):
            return data
        return None


async def fetch_schedule_info(settings: Settings) -> dict:
    """Read prune-job schedule + retention for the configured datastore.

    PBS keeps prune jobs in ``/config/prune`` (one row per job). We surface
    the first job whose ``store`` matches our datastore — most installs have
    a single retention job per store. ``schedule`` is the raw PBS calendar
    spec (systemd timer format, e.g. ``daily 02:00`` or ``Mon..Sun *-*-* 03:00``)
    so the UI can render it verbatim instead of guessing.

    The token only needs ``Datastore.Audit`` on the datastore. Missing prune
    job (no retention configured) is treated as ``reachable=True`` with
    ``schedule=None`` — not an error, just nothing to display.
    """
    if not (settings.pbs_token_id and settings.pbs_token_secret):
        return {
            "reachable": False,
            "error": "PBS-Token nicht konfiguriert",
            "schedule": None,
            "retention": {},
        }
    async with httpx.AsyncClient(verify=settings.pbs_verify_tls, timeout=8.0) as client:
        try:
            jobs = await _get(client, settings, "/config/prune")
        except httpx.HTTPError as e:
            log.info("pbs.schedule_fetch_failed", error=str(e))
            return {
                "reachable": False,
                "error": str(e),
                "schedule": None,
                "retention": {},
            }
    if not isinstance(jobs, list):
        jobs = []
    own = next(
        (j for j in jobs if isinstance(j, dict) and j.get("store") == settings.pbs_datastore),
        None,
    )
    if own is None:
        return {
            "reachable": True,
            "error": None,
            "schedule": None,
            "retention": {},
        }
    retention = {
        "last": own.get("keep-last"),
        "daily": own.get("keep-daily"),
        "weekly": own.get("keep-weekly"),
        "monthly": own.get("keep-monthly"),
        "yearly": own.get("keep-yearly"),
    }
    return {
        "reachable": True,
        "error": None,
        "schedule": own.get("schedule"),
        "retention": {k: v for k, v in retention.items() if v is not None},
    }


async def fetch_backup_summary(settings: Settings) -> BackupSummary:
    if not (settings.pbs_token_id and settings.pbs_token_secret):
        return BackupSummary(
            jobs=[], datastore=None, reachable=False, error="PBS-Token nicht konfiguriert"
        )

    async with httpx.AsyncClient(verify=settings.pbs_verify_tls, timeout=10.0) as client:
        try:
            ds_list = await _get(client, settings, "/status/datastore-usage")
            snapshots = await _get(
                client, settings, f"/admin/datastore/{settings.pbs_datastore}/snapshots"
            )
        except httpx.HTTPError as e:
            log.warning(
                "pbs.fetch_failed",
                host=settings.pbs_host,
                datastore=settings.pbs_datastore,
                error=str(e),
                error_type=type(e).__name__,
            )
            return BackupSummary(
                jobs=[], datastore=None, reachable=False, error=f"PBS unerreichbar: {type(e).__name__}"
            )

    datastore: Datastore | None = None
    for s in ds_list if isinstance(ds_list, list) else []:
        if s.get("store") == settings.pbs_datastore:
            used = int(s.get("used", 0))
            total = int(s.get("total", 0)) or 1
            datastore = Datastore(
                name=settings.pbs_datastore,
                used_b=used,
                total_b=total,
                used_pct=round(used / total * 100, 1),
            )
            break

    jobs: list[BackupSnapshot] = []
    last_success: float = 0.0
    success_today = 0
    total_today = 0
    today = datetime.now(timezone.utc).date()

    for snap in snapshots if isinstance(snapshots, list) else []:
        ts = int(snap.get("backup-time", 0))
        when_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        verify = _verify_status(snap.get("verification"))
        size = int(snap.get("size", 0))
        b_type = str(snap.get("backup-type", "?"))
        b_id = str(snap.get("backup-id", "?"))
        target = f"{b_type}/{b_id}"
        status = "err" if verify == "failed" else ("warn" if verify == "pending" else "ok")
        jobs.append(
            BackupSnapshot(
                id=f"{target}@{ts}",
                target=target,
                backup_type=b_type,
                backup_id=b_id,
                backup_time=ts,
                status=status,  # type: ignore[arg-type]
                verify=verify,  # type: ignore[arg-type]
                size_b=size,
                when_iso=when_iso,
            )
        )
        if datetime.fromtimestamp(ts, tz=timezone.utc).date() == today:
            total_today += 1
            if status == "ok":
                success_today += 1
        if status == "ok" and ts > last_success:
            last_success = ts

    jobs.sort(key=lambda j: j.when_iso, reverse=True)

    # Return every snapshot inside the PBS retention window — the heatmap +
    # storage-by-guest aggregations need full coverage, and the jobs table on
    # the frontend already paginates client-side. A previous ``jobs[:30]``
    # cap meant heavy installs (12+ guests × daily backups) only ever saw
    # ~2 days of history regardless of the 30-day chart range.
    return BackupSummary(
        jobs=jobs,
        datastore=datastore,
        last_success_iso=(
            datetime.fromtimestamp(last_success, tz=timezone.utc).isoformat() if last_success else None
        ),
        success_today=success_today,
        total_today=total_today,
    )
