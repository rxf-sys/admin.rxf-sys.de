from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx

from .. import registry, storage
from ..config import Settings
from ..models import ServiceStatus

# Built-in service catalogue. This is only a *seed*: on first start
# ``registry.seed_builtin_services`` imports it into the registry, after which
# every service (built-in or admin-created) lives in the database and is
# editable / removable through the UI. ``probe_all`` reads only the registry.
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


@dataclass(slots=True)
class _ProbeSpec:
    """A single thing to probe — unifies the built-in catalogue and the
    admin-created custom services so ``probe_all`` has one code path."""

    id: str
    name: str
    icon: str
    desc: str
    sub: str
    int_url: str
    ext_url: str | None
    custom: bool


def _display_host(url: str) -> str:
    """Strip the scheme + trailing slash for a compact subtitle."""
    return url.split("://", 1)[-1].rstrip("/")


async def _build_specs() -> list[_ProbeSpec]:
    """All registered services as a probe list. The built-in catalogue is
    seeded into the registry on first start, so this is the single source."""
    specs: list[_ProbeSpec] = []
    for cs in await registry.list_services():
        internal = str(cs["internal_url"])
        ext = cs.get("ext_url") or None
        specs.append(
            _ProbeSpec(
                id=str(cs["id"]),
                name=str(cs["name"]),
                icon=str(cs["icon"] or "cloud"),
                desc=str(cs["desc"] or ""),
                sub=_display_host(ext or internal),
                int_url=internal,
                ext_url=ext,
                custom=True,
            )
        )
    return specs


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
    specs = await _build_specs()
    # External probes go through Cloudflare with a real cert chain — verify TLS
    # so a MITM/DNS-hijack against the public hostname shows up as down.
    # Internal probes hit LAN hosts with self-signed/private-CA certs, so TLS
    # verification has to stay off there.
    async with (
        httpx.AsyncClient(verify=True, timeout=timeout) as ext_client,
        httpx.AsyncClient(verify=False, timeout=timeout) as int_client,
    ):
        async def run(spec: _ProbeSpec) -> ServiceStatus:
            int_ok, int_ms, int_code = await _probe(int_client, spec.int_url, timeout)
            note: str | None = None
            if spec.ext_url is not None:
                ext_ok, ext_ms, ext_code = await _probe(ext_client, spec.ext_url, timeout)
                ms = int_ms if int_ok else ext_ms
                if not ext_ok and not int_ok:
                    status = "err"
                elif not ext_ok or not int_ok:
                    status = "warn"
                elif ms > 800:
                    status = "warn"
                else:
                    status = "ok"
                if not ext_ok and int_ok:
                    note = "Cloudflare-Tunnel oder DNS-Konfiguration prüfen"
                elif not int_ok and ext_ok:
                    note = "Service intern nicht erreichbar"
            else:
                # Internal-only service (e.g. quick-added from a guest IP).
                ext_ok, ext_ms, ext_code = False, 0, None
                ms = int_ms
                if not int_ok:
                    status = "err"
                elif ms > 800:
                    status = "warn"
                else:
                    status = "ok"
            return ServiceStatus(
                id=spec.id,
                name=spec.name,
                sub=spec.sub,
                icon=spec.icon,
                desc=spec.desc,
                status=status,  # type: ignore[arg-type]
                ms=ms,
                ext=ext_ok,
                internal=int_ok,
                code_ext=ext_code,
                code_int=int_code,
                note=note,
                custom=spec.custom,
                ext_monitored=spec.ext_url is not None,
                internal_url=spec.int_url,
                ext_url=spec.ext_url,
            )

        results = await asyncio.gather(*(run(s) for s in specs))

    # Persist a sample per service for the uptime view. Best-effort; if
    # storage is disabled or the write fails it's a no-op (see storage.py).
    await storage.record_probes([(r.id, r.status, int(r.ms)) for r in results])
    # Track incident transitions so we can answer "last_incident_iso" across
    # restarts. One row per state-change; serial calls within a single
    # incident just bump the worst_status if the new probe is more severe.
    for r in results:
        await storage.update_service_incident(r.id, r.status)
    return list(results)
