from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import structlog
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import accounts, auditor, registry, storage, weekly_report
from .auth import verify_session
from .clients import cloudflare, pbs, probes, proxmox, unifi
from .config import get_settings
from .notify import NotificationCenter, run_notification_loop
from .state import service_snapshot
from .routers import (
    account as account_router,
    admin as admin_router,
    audit,
    auditor as auditor_router,
    auth as auth_router,
    backups,
    certs,
    cloudflare as cloudflare_router,
    instance as instance_router,
    network,
    notifications as notifications_router,
    services,
    system,
    tunnel,
)

_settings = get_settings()
logging.basicConfig(
    level=_settings.log_level,
    stream=sys.stdout,
    format="%(message)s",
)
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer()
        if _settings.app_env == "production"
        else structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(
        logging.getLevelName(_settings.log_level.upper())
    ),
    cache_logger_on_first_use=True,
)

async def _gather_notify_snapshot() -> dict:
    """Pull current state for the notification loop. Best-effort: any exception
    in a sub-call yields its empty default rather than killing the loop.

    Services come from the in-memory probe snapshot — the dedicated probe loop
    is the single source of truth, so we don't fan out a second parallel probe
    pass from here. If the snapshot is empty yet (cold start), services are
    skipped this tick rather than fetched ad-hoc."""
    s = get_settings()
    services_snap, _ = await service_snapshot.get()
    tunnel_status, backup_summary, certs_list = await asyncio.gather(
        cloudflare.fetch_tunnel_status(s),
        pbs.fetch_backup_summary(s),
        cloudflare.fetch_certs(s),
        return_exceptions=True,
    )
    return {
        "services": [
            {"id": x.id, "status": x.status, "ms": x.ms}
            for x in (services_snap or [])
        ],
        "tunnel": (
            {"status": tunnel_status.status}
            if not isinstance(tunnel_status, BaseException)
            else None
        ),
        "backups": (
            backup_summary.model_dump()
            if not isinstance(backup_summary, BaseException)
            else None
        ),
        # fetch_certs returns a (certs, error) tuple; unwrap the list half.
        "certs": [
            {"domain": c.domain, "days_left": c.days_left}
            for c in (certs_list[0] if isinstance(certs_list, tuple) else [])
        ],
    }


async def _auto_audit_loop() -> None:
    """Trigger the audit script once a day around ``audit_auto_hour`` (UTC).

    Uses ``app_settings['auto_audit_last_run_date']`` as a date-stamp guard so
    a restart inside the trigger window doesn't fire a second audit, and so
    the loop's tick interval can stay coarse (5 min). The trigger fires for
    the first matching tick after the hour rolls over; any later ticks on
    the same UTC day are skipped because the date stamp already matches.
    """
    log_ = structlog.get_logger("auto_audit")
    while True:
        try:
            await asyncio.sleep(300)  # check every 5 minutes
            s = get_settings()
            # DB-stored app_settings override the .env defaults so admins can
            # flip the switch without redeploying.
            enabled_str = await accounts.get_app_setting("audit_auto_enabled")
            enabled = (enabled_str == "true") if enabled_str is not None else s.audit_auto_enabled
            if not enabled:
                continue
            hour_str = await accounts.get_app_setting("audit_auto_hour")
            target_hour = int(hour_str) if hour_str and hour_str.isdigit() else s.audit_auto_hour
            target_hour = max(0, min(23, target_hour))
            now = datetime.now(timezone.utc)
            if now.hour != target_hour:
                continue
            today_stamp = now.strftime("%Y-%m-%d")
            last = await accounts.get_app_setting("auto_audit_last_run_date")
            if last == today_stamp:
                continue
            try:
                job_id = await auditor.start_run(s, started_by="auto-audit")
                await accounts.set_app_setting("auto_audit_last_run_date", today_stamp)
                log_.info("auto_audit.triggered", job_id=job_id, date=today_stamp)
            except auditor.AuditorBusy as e:
                log_.info("auto_audit.skipped_busy", running_job=str(e))
            except Exception as e:  # noqa: BLE001
                log_.error("auto_audit.start_failed", error=str(e))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let the loop die
            log_.error("auto_audit.loop_error", error=str(e), error_type=type(e).__name__)


async def _weekly_report_loop() -> None:
    """Send the weekly report every Monday at ``report_hour`` UTC.

    Same date-stamp guard as the auto-audit loop so a restart inside the
    trigger window doesn't double-send. Settings are read from app_settings
    (with .env fallback) on every tick so runtime config changes take effect
    without restarting.
    """
    log_ = structlog.get_logger("weekly_report")
    while True:
        try:
            await asyncio.sleep(300)
            s = get_settings()
            enabled_str = await accounts.get_app_setting("weekly_report_enabled")
            enabled = (enabled_str == "true") if enabled_str is not None else s.weekly_report_enabled
            if not enabled:
                continue
            hour_str = await accounts.get_app_setting("report_hour")
            target_hour = int(hour_str) if hour_str and hour_str.isdigit() else s.report_hour
            target_hour = max(0, min(23, target_hour))
            now = datetime.now(timezone.utc)
            # Monday is weekday 0 in Python's ISO calendar.
            if now.weekday() != 0 or now.hour != target_hour:
                continue
            stamp = now.strftime("%G-W%V")  # ISO year + week → one send per week
            last = await accounts.get_app_setting("weekly_report_last_week")
            if last == stamp:
                continue
            try:
                await weekly_report.send_report(s)
                await accounts.set_app_setting("weekly_report_last_week", stamp)
                log_.info("weekly_report.sent", week=stamp)
            except Exception as e:  # noqa: BLE001
                log_.error("weekly_report.send_failed", error=str(e))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log_.error("weekly_report.loop_error", error=str(e))


async def _history_cleanup_loop() -> None:
    """Periodically drop old metric samples and expired login sessions."""
    while True:
        try:
            await asyncio.sleep(_settings.history_cleanup_interval_s)
            await storage.cleanup_old(_settings.history_retention_days)
            await accounts.cleanup_expired_sessions()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let the loop die
            structlog.get_logger().error(
                "history.cleanup_error", error=str(e), error_type=type(e).__name__
            )


async def _service_probe_loop() -> None:
    """Probe every registered service on a fixed cadence and publish the
    result into ``service_snapshot``. Single source of truth for both the
    /api/services handler and the notification loop, so multiple open
    dashboards or a parallel notify tick never multiply upstream load.

    Wakes early when CRUD on the service registry calls
    ``service_snapshot.request_refresh()``.
    """
    log_ = structlog.get_logger("probes")
    while True:
        try:
            results = await probes.probe_all(_settings)
            await service_snapshot.set(results)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let the loop die
            log_.error(
                "probe.loop_error", error=str(e), error_type=type(e).__name__
            )
        await service_snapshot.wait_for_tick(_settings.probe_interval_s)


async def _metrics_sample_loop() -> None:
    """Pull guest CPU/RAM and WAN throughput every tick and persist them.

    Lets the dashboard draw 24h CPU/RAM-per-guest and 1h WAN-throughput
    charts without leaning on each upstream's (missing) history endpoints.
    Best-effort: if either upstream is unreachable on this tick we skip
    writing for that side rather than killing the loop.
    """
    interval = max(15, _settings.metrics_sample_interval_s)
    log_ = structlog.get_logger("metrics")
    while True:
        try:
            await asyncio.sleep(interval)
            guests_task = asyncio.create_task(proxmox.fetch_guests(_settings))
            host_task = asyncio.create_task(proxmox.fetch_host_status(_settings))
            net_task = asyncio.create_task(unifi.fetch_network_snapshot(_settings))
            guests, host, net = await asyncio.gather(
                guests_task, host_task, net_task, return_exceptions=True
            )
            if isinstance(guests, list):
                rows = [
                    (g.id, float(g.cpu_pct), int(g.ram_used_b), int(g.ram_total_b))
                    for g in guests
                    if g.running and g.type != "HOST"
                ]
                await storage.record_guest_metrics(rows)
            else:
                log_.info("metrics.guests_skip", error=str(guests))
            if not isinstance(host, BaseException) and host.online:
                await storage.record_host_metrics(
                    cpu_pct=float(host.cpu_pct),
                    ram_used_b=int(host.ram_used_b),
                    ram_total_b=int(host.ram_total_b),
                    disk_used_b=int(host.disk_used_b),
                    disk_total_b=int(host.disk_total_b),
                    cpu_temp_c=host.cpu_temp_c,
                )
            elif isinstance(host, BaseException):
                log_.info("metrics.host_skip", error=str(host))
            if not isinstance(net, BaseException) and net.reachable:
                await storage.record_network_metrics(
                    float(net.throughput_down_mbit), float(net.throughput_up_mbit)
                )
            elif isinstance(net, BaseException):
                log_.info("metrics.network_skip", error=str(net))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let the loop die
            log_.error(
                "metrics.sample_error", error=str(e), error_type=type(e).__name__
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    notify_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = None
    metrics_task: asyncio.Task | None = None
    probe_task: asyncio.Task | None = None
    auto_audit_task: asyncio.Task | None = None
    weekly_report_task: asyncio.Task | None = None

    # Account auth is mandatory — its schema + first-admin bootstrap run
    # before anything else so the API is never up without a way to log in.
    await accounts.ensure_schema(_settings)
    await accounts.bootstrap_admin(_settings)

    # Admin-managed registry (services + guest labels) shares the mandatory
    # account database, so its schema runs alongside accounts. The built-in
    # service catalogue is seeded into it once so every service is editable.
    await registry.ensure_schema(_settings)
    await registry.seed_builtin_services(_settings, probes.SERVICES)

    # Audit-runner state (audit_runs table) also lives in the account DB.
    await auditor.ensure_schema(_settings)

    await storage.ensure_schema(_settings)
    # The cleanup loop prunes expired sessions too, so it runs even when the
    # opt-in metrics storage is disabled.
    cleanup_task = asyncio.create_task(_history_cleanup_loop())
    if storage.is_enabled() and _settings.metrics_sample_interval_s > 0:
        metrics_task = asyncio.create_task(_metrics_sample_loop())

    # Seed the service snapshot synchronously so the first /api/services call
    # never sees an empty snapshot. Best-effort: if any upstream fails the
    # background loop will retry on its next tick.
    if _settings.probe_interval_s > 0:
        try:
            initial = await probes.probe_all(_settings)
            await service_snapshot.set(initial)
        except Exception as e:  # noqa: BLE001 - never block startup on probes
            structlog.get_logger().warning(
                "probe.initial_seed_failed", error=str(e), error_type=type(e).__name__
            )
        probe_task = asyncio.create_task(_service_probe_loop())

    # Auto-audit loop runs unconditionally; it checks the audit_auto_enabled
    # setting on every tick so an admin can flip the switch at runtime
    # without bouncing the backend.
    auto_audit_task = asyncio.create_task(_auto_audit_loop())
    weekly_report_task = asyncio.create_task(_weekly_report_loop())

    if _settings.notify_webhook_url or _settings.ntfy_base:
        center = NotificationCenter(settings=_settings)
        notify_task = asyncio.create_task(
            run_notification_loop(
                center, _gather_notify_snapshot, interval_s=_settings.notify_interval_s
            )
        )
        structlog.get_logger().info(
            "notify.enabled",
            interval_s=_settings.notify_interval_s,
            webhook=bool(_settings.notify_webhook_url),
            ntfy=bool(_settings.ntfy_base),
        )
    else:
        structlog.get_logger().info("notify.disabled")
    try:
        yield
    finally:
        for task in (notify_task, cleanup_task, metrics_task, probe_task, auto_audit_task, weekly_report_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


# Interactive docs + OpenAPI schema are dev conveniences: in production the
# API sits behind the public Cloudflare tunnel, and both endpoints are
# unauthenticated by design — exposing the full route/parameter map of an
# admin dashboard there is unnecessary recon surface.
_DOCS_ENABLED = _settings.app_env != "production"

app = FastAPI(
    title="rxf-sys admin",
    description="Backend API for the rxf-sys homeserver admin dashboard.",
    version="0.1.0",
    docs_url="/api/docs" if _DOCS_ENABLED else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if _DOCS_ENABLED else None,
    lifespan=lifespan,
)

settings = _settings
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/me")
async def me(user: dict = Depends(verify_session)) -> dict:
    """Current account identity. Kept for the frontend's existing api.me()."""
    return {
        "id": user["id"],
        "username": user["username"],
        "email": user.get("email"),
        "role": user.get("role", "user"),
    }


app.include_router(auth_router.router)
app.include_router(account_router.router)
app.include_router(admin_router.router)
app.include_router(instance_router.router)
app.include_router(notifications_router.router)
app.include_router(system.router)
app.include_router(services.router)
app.include_router(tunnel.router)
app.include_router(backups.router)
app.include_router(network.router)
app.include_router(certs.router)
app.include_router(audit.router)
app.include_router(audit.events_router)
app.include_router(auditor_router.router)
app.include_router(cloudflare_router.router)
