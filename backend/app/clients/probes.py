from __future__ import annotations

import asyncio
import time

import httpx

from ..config import Settings
from ..models import ServiceStatus

# Service catalogue mirrors the design mockup exactly.
SERVICES: list[dict[str, str]] = [
    {"id": "vault",   "name": "vault",   "icon": "lock",    "desc": "Vaultwarden — Passwörter"},
    {"id": "cloud",   "name": "cloud",   "icon": "cloud",   "desc": "Nextcloud — Files & Sync"},
    {"id": "photos",  "name": "photos",  "icon": "photo",   "desc": "Immich — Fotos"},
    {"id": "docs",    "name": "docs",    "icon": "doc",     "desc": "Paperless-ngx — Dokumente"},
    {"id": "media",   "name": "media",   "icon": "media",   "desc": "Jellyfin — Media"},
    {"id": "ha",      "name": "ha",      "icon": "home",    "desc": "Home Assistant"},
    {"id": "monitor", "name": "monitor", "icon": "monitor", "desc": "Uptime Kuma"},
    {"id": "pbs",     "name": "pbs",     "icon": "archive", "desc": "Proxmox Backup Server"},
]


async def _probe(client: httpx.AsyncClient, url: str, timeout: float) -> tuple[bool, int, int | None]:
    """Returns (reachable, ms, http_status)."""
    start = time.perf_counter()
    try:
        # GET (not HEAD) — many self-hosted apps return 405/redirect on HEAD.
        r = await client.get(url, timeout=timeout, follow_redirects=False)
        ms = int((time.perf_counter() - start) * 1000)
        # 2xx, 3xx, 401 (auth wall) and 405 all mean the service is up.
        ok = r.status_code < 500 and r.status_code != 502 and r.status_code != 503
        return ok, ms, r.status_code
    except (httpx.HTTPError, asyncio.TimeoutError):
        ms = int((time.perf_counter() - start) * 1000)
        return False, ms, None


async def probe_all(settings: Settings) -> list[ServiceStatus]:
    results: list[ServiceStatus] = []
    timeout = settings.probe_timeout_s
    # External probes go through Cloudflare with a real cert chain — verify TLS
    # so a MITM/DNS-hijack against the public hostname shows up as down.
    # Internal probes hit LAN hosts with self-signed/private-CA certs, so TLS
    # verification has to stay off there.
    async with (
        httpx.AsyncClient(verify=True, timeout=timeout) as ext_client,
        httpx.AsyncClient(verify=False, timeout=timeout) as int_client,
    ):
        async def run(svc: dict[str, str]) -> ServiceStatus:
            sub_id = svc["id"]
            ext_url = f"https://{sub_id}.{settings.cf_zone_name}"
            int_url = settings.probe_targets.get(sub_id, ext_url)
            (ext_ok, ext_ms, ext_code), (int_ok, int_ms, int_code) = await asyncio.gather(
                _probe(ext_client, ext_url, timeout),
                _probe(int_client, int_url, timeout),
            )
            ms = int_ms if int_ok else ext_ms
            if not ext_ok and not int_ok:
                status = "err"
            elif not ext_ok or not int_ok:
                status = "warn"
            elif ms > 800:
                status = "warn"
            else:
                status = "ok"
            note = None
            if not ext_ok and int_ok:
                note = "Cloudflare-Tunnel oder DNS-Konfiguration prüfen"
            elif not int_ok and ext_ok:
                note = "Service intern nicht erreichbar"
            return ServiceStatus(
                id=sub_id,
                name=svc["name"],
                sub=f"{sub_id}.{settings.cf_zone_name}",
                icon=svc["icon"],
                desc=svc["desc"],
                status=status,  # type: ignore[arg-type]
                ms=ms,
                ext=ext_ok,
                internal=int_ok,
                code_ext=ext_code,
                code_int=int_code,
                note=note,
            )

        results = await asyncio.gather(*(run(s) for s in SERVICES))
    return list(results)
