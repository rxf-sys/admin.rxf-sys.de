from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import storage
from .auth import verify_cf_access
from .clients import cloudflare, pbs, probes
from .config import get_settings
from .notify import NotificationCenter, run_notification_loop
from .routers import audit, backups, certs, network, services, system, tunnel

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
    in a sub-call yields its empty default rather than killing the loop."""
    s = get_settings()
    services_list, tunnel_status, backup_summary, certs_list = await asyncio.gather(
        probes.probe_all(s),
        cloudflare.fetch_tunnel_status(s),
        pbs.fetch_backup_summary(s),
        cloudflare.fetch_certs(s),
        return_exceptions=True,
    )
    return {
        "services": [
            {"id": x.id, "status": x.status, "ms": x.ms}
            for x in (services_list if isinstance(services_list, list) else [])
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
        "certs": [
            {"domain": c.domain, "days_left": c.days_left}
            for c in (certs_list if isinstance(certs_list, list) else [])
        ],
    }


async def _history_cleanup_loop() -> None:
    """Periodically drop probe samples older than the retention window."""
    while True:
        try:
            await asyncio.sleep(_settings.history_cleanup_interval_s)
            await storage.cleanup_old(_settings.history_retention_days)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let the loop die
            structlog.get_logger().error(
                "history.cleanup_error", error=str(e), error_type=type(e).__name__
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    notify_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = None

    await storage.ensure_schema(_settings)
    if storage.is_enabled():
        cleanup_task = asyncio.create_task(_history_cleanup_loop())

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
        for task in (notify_task, cleanup_task):
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
async def me(claims: dict = Depends(verify_cf_access)) -> dict:
    return {
        "email": claims.get("email"),
        "sub": claims.get("sub"),
        "aud": claims.get("aud"),
    }


app.include_router(system.router)
app.include_router(services.router)
app.include_router(tunnel.router)
app.include_router(backups.router)
app.include_router(network.router)
app.include_router(certs.router)
app.include_router(audit.router)
