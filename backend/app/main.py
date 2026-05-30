from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import accounts, auditor, registry, storage
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

    if _settings.notify_webhook_url:
        center = NotificationCenter(settings=_settings)
        notify_task = asyncio.create_task(
            run_notification_loop(
                center, _gather_notify_snapshot, interval_s=_settings.notify_interval_s
            )
        )
        structlog.get_logger().info("notify.enabled", interval_s=_settings.notify_interval_s)
    else:
        structlog.get_logger().info("notify.disabled")
    try:
        yield
    finally:
        for task in (notify_task, cleanup_task, metrics_task, probe_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(
    title="rxf-sys admin",
    description="Backend API for the rxf-sys homeserver admin dashboard.",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
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
