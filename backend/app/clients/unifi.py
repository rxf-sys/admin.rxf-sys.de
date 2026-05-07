"""UniFi Network Integration API client.

Endpoints follow the official spec at developer.ui.com (UniFi Network 10.x):

    Base:    /proxy/network/integration/v1
    Header:  X-API-Key: <key>

    GET /sites
    GET /sites/{siteId}
    GET /sites/{siteId}/networks
    GET /sites/{siteId}/clients
    GET /sites/{siteId}/devices
    GET /info     (controller version + features)

Legacy username/password cookie auth is kept as a fallback for installations
on Network < 8.x where the integration API is not available. If everything
fails the snapshot returns ``reachable=False`` with an ``error`` string so the
UI can show the user *what* broke instead of a blank card.
"""

from __future__ import annotations

import asyncio
import time

import httpx
import structlog

from ..config import Settings
from ..models import NetworkSegment, NetworkSnapshot

log = structlog.get_logger("unifi")

# Per developer.ui.com docs (Local connection type, v10.1.84):
#   GET https://<host>/proxy/network/integration/v1/sites/{siteId}/networks/{networkId}
INTEGRATION_BASE = "/proxy/network/integration/v1"

_LOGIN_LOCK = asyncio.Lock()


class _Session:
    cookies: httpx.Cookies | None = None
    csrf: str | None = None
    last_login: float = 0.0


_session = _Session()


def _base(settings: Settings) -> str:
    return f"https://{settings.unifi_host}:{settings.unifi_port}"


# ---------------------------------------------------------------------------
# Integration API
# ---------------------------------------------------------------------------


def _integration_headers(settings: Settings) -> dict[str, str]:
    return {
        "X-API-Key": settings.unifi_api_key,
        "Accept": "application/json",
    }


async def _int_get(
    client: httpx.AsyncClient, settings: Settings, path: str
) -> dict | list | None:
    """GET helper for the integration API. Returns parsed JSON or None."""
    url = f"{_base(settings)}{INTEGRATION_BASE}{path}"
    try:
        r = await client.get(url, headers=_integration_headers(settings))
    except httpx.HTTPError as e:
        log.info("unifi.int_request_error", path=path, error=str(e))
        return None
    if r.status_code != 200:
        log.info("unifi.int_status_not_ok", path=path, status=r.status_code)
        return None
    try:
        return r.json()
    except ValueError:
        log.info("unifi.int_non_json", path=path)
        return None


def _unwrap(body: dict | list | None) -> list:
    """The Integration API returns either ``{"data": [...]}`` or a bare array
    depending on endpoint. Normalise to a list."""
    if body is None:
        return []
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        data = body.get("data")
        if isinstance(data, list):
            return data
        # Some endpoints (e.g. /info) return a bare object, not a list.
        return [body]
    return []


async def _try_integration(
    client: httpx.AsyncClient, settings: Settings
) -> NetworkSnapshot | None:
    """Returns a populated snapshot or None if the integration API isn't usable."""
    if not settings.unifi_api_key:
        return None

    sites_body = await _int_get(client, settings, "/sites")
    if sites_body is None:
        log.info("unifi.integration_unavailable", path="/sites")
        return None

    sites = _unwrap(sites_body)
    if not sites:
        return NetworkSnapshot(
            reachable=False,
            error="UniFi: keine Sites zurückgeliefert",
            auth_mode="api-key",
        )

    # Pick the requested site by name (also accept matching id), else first.
    site_obj: dict | None = None
    target = settings.unifi_site
    for s in sites:
        if not isinstance(s, dict):
            continue
        if s.get("name") == target or s.get("id") == target:
            site_obj = s
            break
    if site_obj is None:
        site_obj = next((s for s in sites if isinstance(s, dict)), None)
    if site_obj is None:
        return NetworkSnapshot(
            reachable=False, error="UniFi: keine Site gefunden", auth_mode="api-key"
        )

    site_id = site_obj.get("id") or site_obj.get("name") or target
    site_name = site_obj.get("name") or "?"

    # Pull networks, clients, devices in parallel — all best-effort.
    nets_task = _int_get(client, settings, f"/sites/{site_id}/networks")
    clients_task = _int_get(client, settings, f"/sites/{site_id}/clients")
    devices_task = _int_get(client, settings, f"/sites/{site_id}/devices")
    nets_body, clients_body, devices_body = await asyncio.gather(
        nets_task, clients_task, devices_task
    )

    nets = _unwrap(nets_body)
    clients_raw = _unwrap(clients_body)
    devices = _unwrap(devices_body)

    # Count clients per vlanId (documented field name).
    by_vlan: dict[int | None, int] = {}
    for c in clients_raw:
        if not isinstance(c, dict):
            continue
        vlan = c.get("vlanId")
        try:
            vlan_int = int(vlan) if vlan is not None else None
        except (TypeError, ValueError):
            vlan_int = None
        by_vlan[vlan_int] = by_vlan.get(vlan_int, 0) + 1

    networks: list[NetworkSegment] = []
    for n in nets:
        if not isinstance(n, dict):
            continue
        vlan = n.get("vlanId")
        try:
            vlan_int = int(vlan) if vlan is not None else None
        except (TypeError, ValueError):
            vlan_int = None
        networks.append(
            NetworkSegment(
                name=n.get("name") or "?",
                vlan=vlan_int,
                clients=by_vlan.get(vlan_int, 0),
            )
        )

    # WAN info: best-effort lookup on the gateway device (UCG-Ultra etc.).
    # The integration API exposes per-device info; field names vary slightly
    # by firmware, so we sniff the common shapes.
    wan_ip = None
    isp = None
    down_mbit = up_mbit = 0.0
    link_down = link_up = None
    for d in devices:
        if not isinstance(d, dict):
            continue
        # Heuristic: only the gateway will have WAN/uplink info.
        role = (d.get("role") or d.get("type") or "").lower()
        if role and role not in ("gateway", "udm", "ucg", "router"):
            continue
        wan = d.get("wan") or d.get("uplink") or d.get("internet") or {}
        if not isinstance(wan, dict):
            continue
        wan_ip = wan_ip or wan.get("ip") or wan.get("publicIp")
        isp = isp or wan.get("ispName") or wan.get("isp")
        if isinstance(wan.get("rxRateBps"), (int, float)):
            down_mbit = float(wan["rxRateBps"]) * 8 / 1_000_000
        elif isinstance(wan.get("downloadKbps"), (int, float)):
            down_mbit = float(wan["downloadKbps"]) / 1000.0
        if isinstance(wan.get("txRateBps"), (int, float)):
            up_mbit = float(wan["txRateBps"]) * 8 / 1_000_000
        elif isinstance(wan.get("uploadKbps"), (int, float)):
            up_mbit = float(wan["uploadKbps"]) / 1000.0
        if isinstance(wan.get("downlinkSpeedMbps"), (int, float)):
            link_down = float(wan["downlinkSpeedMbps"])
        if isinstance(wan.get("uplinkSpeedMbps"), (int, float)):
            link_up = float(wan["uplinkSpeedMbps"])
        if wan_ip:  # first matching device with WAN info wins
            break

    log.info(
        "unifi.integration_ok",
        site=site_name,
        site_id=site_id,
        networks=len(networks),
        clients=len(clients_raw),
        devices=len(devices),
        wan_ip=wan_ip is not None,
    )
    return NetworkSnapshot(
        wan_ip=wan_ip,
        isp=isp,
        link_down_mbit=link_down,
        link_up_mbit=link_up,
        throughput_down_mbit=round(down_mbit, 2),
        throughput_up_mbit=round(up_mbit, 2),
        networks=networks,
        clients_total=len(clients_raw),
        reachable=True,
        error=None,
        auth_mode="api-key",
    )


# ---------------------------------------------------------------------------
# Legacy cookie auth (fallback for Network < 8.x)
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
