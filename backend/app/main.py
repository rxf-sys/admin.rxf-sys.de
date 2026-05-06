from __future__ import annotations

import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import verify_cf_access
from .config import get_settings
from .routers import backups, certs, network, services, system, tunnel

logging.basicConfig(level=get_settings().log_level)

app = FastAPI(
    title="rxf-sys admin",
    description="Backend API for the rxf-sys homeserver admin dashboard.",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)

settings = get_settings()
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
