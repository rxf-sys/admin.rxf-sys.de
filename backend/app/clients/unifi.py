from __future__ import annotations

import asyncio
import time

import httpx

from ..config import Settings
from ..models import NetworkSegment, NetworkSnapshot

# UniFi OS local API: cookie-based auth at /api/auth/login, then proxied
# to /proxy/network/api/s/<site>/...

_LOGIN_LOCK = asyncio.Lock()


class _Session:
    cookies: httpx.Cookies | None = None
    csrf: str | None = None
    last_login: float = 0.0


_session = _Session()


def _base(settings: Settings) -> str:
    return f"https://{settings.unifi_host}:{settings.unifi_port}"


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


async def _request(
    settings: Settings, method: str, path: str, **kwargs
) -> httpx.Response:
    async with httpx.AsyncClient(verify=settings.unifi_verify_tls, timeout=8.0) as client:
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


async def fetch_network_snapshot(settings: Settings) -> NetworkSnapshot:
    if not (settings.unifi_username and settings.unifi_password):
        return NetworkSnapshot()

    site = settings.unifi_site
    try:
        health_r = await _request(settings, "GET", f"/proxy/network/api/s/{site}/stat/health")
        clients_r = await _request(settings, "GET", f"/proxy/network/api/s/{site}/stat/sta")
        nets_r = await _request(settings, "GET", f"/proxy/network/api/s/{site}/rest/networkconf")
    except (httpx.HTTPError, asyncio.TimeoutError):
        return NetworkSnapshot()

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
            # tx/rx are in bytes/sec on most firmwares
            down_mbit = float(sub.get("rx-bytes-r", 0)) * 8 / 1_000_000
            up_mbit = float(sub.get("tx-bytes-r", 0)) * 8 / 1_000_000
            link_down = float(sub.get("xput_down", 0)) or None
            link_up = float(sub.get("xput_up", 0)) or None

    # Group clients by network/VLAN
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
    )
