"""UniFi Network client.

Supports two auth modes:

1. **Integration API** (preferred, UniFi OS 4.x+) — static API key in the
   ``X-API-KEY`` header. Endpoints live under ``/proxy/network/integration/v1``.
   Different firmware revisions expose slightly different paths, so we probe a
   small set and use the first that responds 2xx.

2. **Legacy cookie auth** — POST username/password to ``/api/auth/login``,
   then call the v1 ``/proxy/network/api/s/<site>/...`` endpoints. Used only
   when no API key is configured.

If everything fails the snapshot returns ``reachable=False`` with an ``error``
string so the UI can tell the user *what* broke instead of just blanking out.
"""

from __future__ import annotations

import asyncio
import time

import httpx
import structlog

from ..config import Settings
from ..models import NetworkSegment, NetworkSnapshot

log = structlog.get_logger("unifi")

_LOGIN_LOCK = asyncio.Lock()


class _Session:
    cookies: httpx.Cookies | None = None
    csrf: str | None = None
    last_login: float = 0.0


_session = _Session()


def _base(settings: Settings) -> str:
    return f"https://{settings.unifi_host}:{settings.unifi_port}"


# ---------------------------------------------------------------------------
# Integration API (preferred)
# ---------------------------------------------------------------------------

# Different firmware versions have shipped slightly different roots; probe in
# order until one responds with a sites list.
_INTEGRATION_ROOTS = [
    "/proxy/network/integration/v1",
    "/proxy/network/v2/api/site",
    "/proxy/network/api/integrations/v1",
]


async def _try_integration(
    client: httpx.AsyncClient, settings: Settings
) -> NetworkSnapshot | None:
    """Returns a populated snapshot or None if integration API isn't available."""
    if not settings.unifi_api_key:
        return None

    headers = {"X-API-KEY": settings.unifi_api_key, "Accept": "application/json"}

    sites = None
    chosen_root: str | None = None
    last_err: str = "no integration root responded"
    for root in _INTEGRATION_ROOTS:
        try:
            r = await client.get(f"{_base(settings)}{root}/sites", headers=headers)
        except httpx.HTTPError as e:
            last_err = f"{type(e).__name__}: {e}"
            continue
        if r.status_code == 200:
            chosen_root = root
            try:
                body = r.json()
            except ValueError:
                last_err = "sites endpoint returned non-JSON"
                continue
            sites = body.get("data", body) if isinstance(body, dict) else body
            break
        last_err = f"sites HTTP {r.status_code}"

    if not chosen_root or not sites:
        log.info("unifi.integration_unavailable", error=last_err)
        return None

    site_obj = None
    for s in sites if isinstance(sites, list) else []:
        if s.get("name") == settings.unifi_site or s.get("internalReference") == settings.unifi_site:
            site_obj = s
            break
    if site_obj is None and isinstance(sites, list) and sites:
        site_obj = sites[0]
    if site_obj is None:
        return NetworkSnapshot(
            reachable=False, error="UniFi: keine Site gefunden", auth_mode="api-key"
        )
    site_id = site_obj.get("id") or site_obj.get("siteId") or site_obj.get("name")

    async def _get(path: str) -> dict | list | None:
        try:
            r = await client.get(f"{_base(settings)}{chosen_root}{path}", headers=headers)
            if r.status_code == 200:
                return r.json()
            log.info("unifi.integration_endpoint_status", path=path, status=r.status_code)
        except httpx.HTTPError as e:
            log.info("unifi.integration_endpoint_error", path=path, error=str(e))
        return None

    overview = await _get(f"/sites/{site_id}/site-overview") or {}
    if isinstance(overview, dict):
        overview = overview.get("data", overview)
    clients = await _get(f"/sites/{site_id}/clients") or {}

    clients_list = (
        clients.get("data", clients) if isinstance(clients, dict) else clients
    )
    if not isinstance(clients_list, list):
        clients_list = []

    by_vlan: dict[int | None, int] = {}
    for c in clients_list:
        vlan = c.get("vlan") if isinstance(c, dict) else None
        try:
            vlan_int = int(vlan) if vlan is not None else None
        except (TypeError, ValueError):
            vlan_int = None
        by_vlan[vlan_int] = by_vlan.get(vlan_int, 0) + 1

    nets_list = []
    if isinstance(overview, dict):
        nets_list = overview.get("networks", []) or []
    if not nets_list:
        nets = await _get(f"/sites/{site_id}/networks") or {}
        nets_list = nets.get("data", nets) if isinstance(nets, dict) else nets
        if not isinstance(nets_list, list):
            nets_list = []

    networks: list[NetworkSegment] = []
    for n in nets_list:
        if not isinstance(n, dict):
            continue
        vlan = n.get("vlan") or n.get("vlanId") or n.get("vlan_id")
        try:
            vlan_int = int(vlan) if vlan is not None else None
        except (TypeError, ValueError):
            vlan_int = None
        networks.append(
            NetworkSegment(
                name=n.get("name") or n.get("displayName", "?"),
                vlan=vlan_int,
                clients=by_vlan.get(vlan_int, 0),
            )
        )

    wan_ip = None
    isp = None
    down_mbit = up_mbit = 0.0
    link_down = link_up = None
    if isinstance(overview, dict):
        wan = overview.get("wan") or overview.get("internet") or {}
        if isinstance(wan, dict):
            wan_ip = wan.get("ip") or wan.get("publicIp")
            isp = wan.get("ispName") or wan.get("isp")
            tp = wan.get("throughput") or {}
            if tp.get("downloadKbps"):
                down_mbit = float(tp["downloadKbps"]) / 1000.0
            elif wan.get("rxRateBps"):
                down_mbit = float(wan["rxRateBps"]) * 8 / 1_000_000
            if tp.get("uploadKbps"):
                up_mbit = float(tp["uploadKbps"]) / 1000.0
            elif wan.get("txRateBps"):
                up_mbit = float(wan["txRateBps"]) * 8 / 1_000_000
            link_down = float(wan.get("downlinkSpeedMbps") or 0) or None
            link_up = float(wan.get("uplinkSpeedMbps") or 0) or None

    log.info(
        "unifi.integration_ok",
        root=chosen_root,
        site=site_obj.get("name"),
        clients=len(clients_list),
        networks=len(networks),
    )
    return NetworkSnapshot(
        wan_ip=wan_ip,
        isp=isp,
        link_down_mbit=link_down,
        link_up_mbit=link_up,
        throughput_down_mbit=round(down_mbit, 2),
        throughput_up_mbit=round(up_mbit, 2),
        networks=networks,
        clients_total=len(clients_list),
        reachable=True,
        error=None,
        auth_mode="api-key",
    )


# ---------------------------------------------------------------------------
# Legacy cookie auth (fallback)
# ---------------------------------------------------------------------------


async def _login(client: httpx.AsyncClient, settings: Settings) -> None:
    if not (settings.unifi_username and settings.unifi_password):
        raise httpx.HTTPError("unifi credentials not configured")
    r = await client.post(
        f"{_base(settings)}/api/auth/login",
        json={"username": settings.unifi_username, "password": settings.unifi_password},
    )
    r.raise_for_status()
    _session.cookies = r.cookies
    _session.csrf = r.headers.get("X-CSRF-Token") or r.headers.get("x-csrf-token")
    _session.last_login = time.monotonic()


async def _legacy_request(
    client: httpx.AsyncClient, settings: Settings, method: str, path: str, **kwargs
) -> httpx.Response:
    async with _LOGIN_LOCK:
        stale = (time.monotonic() - _session.last_login) > 1800
        if _session.cookies is None or stale:
            await _login(client, settings)

    headers = dict(kwargs.pop("headers", {}))
    if _session.csrf:
        headers["X-CSRF-Token"] = _session.csrf

    r = await client.request(
        method, f"{_base(settings)}{path}", cookies=_session.cookies, headers=headers, **kwargs
    )
    if r.status_code == 401:
        async with _LOGIN_LOCK:
            await _login(client, settings)
        if _session.csrf:
            headers["X-CSRF-Token"] = _session.csrf
        r = await client.request(
            method, f"{_base(settings)}{path}", cookies=_session.cookies, headers=headers, **kwargs
        )
    r.raise_for_status()
    return r


async def _try_legacy(
    client: httpx.AsyncClient, settings: Settings
) -> NetworkSnapshot | None:
    if not (settings.unifi_username and settings.unifi_password):
        return None
    site = settings.unifi_site
    try:
        health_r = await _legacy_request(client, settings, "GET", f"/proxy/network/api/s/{site}/stat/health")
        clients_r = await _legacy_request(client, settings, "GET", f"/proxy/network/api/s/{site}/stat/sta")
        nets_r = await _legacy_request(client, settings, "GET", f"/proxy/network/api/s/{site}/rest/networkconf")
    except (httpx.HTTPError, asyncio.TimeoutError) as e:
        log.warning("unifi.legacy_failed", error=str(e), error_type=type(e).__name__)
        return NetworkSnapshot(
            reachable=False, error=f"Legacy-Auth: {type(e).__name__}", auth_mode="cookie"
        )

    health_data = health_r.json().get("data", [])
    clients_data = clients_r.json().get("data", [])
    nets_data = nets_r.json().get("data", [])

    wan_ip = None
    isp = None
    down_mbit = up_mbit = 0.0
    link_down = link_up = None
    for sub in health_data:
        if sub.get("subsystem") == "wan":
            wan_ip = sub.get("wan_ip")
            isp = sub.get("isp_name")
            down_mbit = float(sub.get("rx-bytes-r", 0)) * 8 / 1_000_000
            up_mbit = float(sub.get("tx-bytes-r", 0)) * 8 / 1_000_000
            link_down = float(sub.get("xput_down", 0)) or None
            link_up = float(sub.get("xput_up", 0)) or None

    by_vlan: dict[int | None, int] = {}
    for c in clients_data:
        vlan = c.get("vlan")
        by_vlan[vlan] = by_vlan.get(vlan, 0) + 1

    networks: list[NetworkSegment] = []
    for n in nets_data:
        vlan = n.get("vlan") or n.get("vlan_id")
        try:
            vlan_int = int(vlan) if vlan is not None else None
        except (TypeError, ValueError):
            vlan_int = None
        networks.append(
            NetworkSegment(
                name=n.get("name", "?"),
                vlan=vlan_int,
                clients=by_vlan.get(vlan_int, 0),
            )
        )

    return NetworkSnapshot(
        wan_ip=wan_ip,
        isp=isp,
        link_down_mbit=link_down,
        link_up_mbit=link_up,
        throughput_down_mbit=round(down_mbit, 2),
        throughput_up_mbit=round(up_mbit, 2),
        networks=networks,
        clients_total=len(clients_data),
        reachable=True,
        error=None,
        auth_mode="cookie",
    )


async def fetch_network_snapshot(settings: Settings) -> NetworkSnapshot:
    if not (
        settings.unifi_api_key
        or (settings.unifi_username and settings.unifi_password)
    ):
        return NetworkSnapshot(
            reachable=False,
            error="UniFi: weder API-Key noch Username/Password konfiguriert",
            auth_mode="none",
        )

    async with httpx.AsyncClient(verify=settings.unifi_verify_tls, timeout=8.0) as client:
        snap = await _try_integration(client, settings)
        if snap is not None and snap.reachable:
            return snap

        snap2 = await _try_legacy(client, settings)
        if snap2 is not None:
            return snap2

        if snap is not None:
            return snap
        return NetworkSnapshot(
            reachable=False,
            error="UniFi: weder Integration-API noch Cookie-Auth verfügbar",
            auth_mode="none",
        )
