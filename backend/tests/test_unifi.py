from __future__ import annotations

import httpx
import pytest
import respx

from app.clients import unifi
from app.config import Settings


@pytest.fixture(autouse=True)
def _reset_session():
    """Each test starts with a fresh cookie-auth session state."""
    unifi._session.cookies = None
    unifi._session.csrf = None
    unifi._session.last_login = 0.0


@pytest.mark.asyncio
async def test_no_credentials_yields_unreachable():
    s = Settings(unifi_api_key="", unifi_username="", unifi_password="")
    snap = await unifi.fetch_network_snapshot(s)
    assert snap.reachable is False
    assert snap.auth_mode == "none"
    assert "weder" in (snap.error or "")


@pytest.mark.asyncio
@respx.mock
async def test_integration_api_happy_path():
    """Documented endpoint shapes from developer.ui.com (Network v10.1.84).

    The Integration API base path on a local controller is
    /proxy/network/integration/v1. Sites and networks are identified by
    UUIDs; networks expose a `vlanId` field and clients expose `vlanId`.
    """
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_site="default",
    )
    base = "https://unifi.test:443/proxy/network/integration/v1"
    site_uuid = "11111111-1111-1111-1111-111111111111"

    respx.get(f"{base}/sites").respond(
        200,
        json={
            "data": [
                {"id": site_uuid, "name": "default"},
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/networks").respond(
        200,
        json={
            "data": [
                {"id": "n1", "name": "LAN", "vlanId": 1, "enabled": True},
                {"id": "n2", "name": "IoT", "vlanId": 30, "enabled": True},
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/clients").respond(
        200,
        json={
            "data": [
                {"id": "c1", "vlanId": 1},
                {"id": "c2", "vlanId": 1},
                {"id": "c3", "vlanId": 30},
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/devices").respond(
        200,
        json={
            "data": [
                {
                    "id": "d1",
                    "role": "gateway",
                    "wan": {
                        "ip": "1.2.3.4",
                        "ispName": "Vodafone",
                        "rxRateBps": 12_500_000,  # 100 Mbit
                        "txRateBps": 1_250_000,   # 10 Mbit
                    },
                }
            ]
        },
    )

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is True
    assert snap.auth_mode == "api-key"
    assert snap.wan_ip == "1.2.3.4"
    assert snap.isp == "Vodafone"
    assert snap.clients_total == 3
    assert snap.throughput_down_mbit == 100.0
    assert snap.throughput_up_mbit == 10.0
    by_name = {n.name: n for n in snap.networks}
    assert by_name["LAN"].clients == 2
    assert by_name["IoT"].clients == 1


@pytest.mark.asyncio
@respx.mock
async def test_integration_falls_back_to_legacy_when_unavailable():
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_username="admin",
        unifi_password="pass",
        unifi_site="default",
    )
    # Integration API: /sites returns 404 (not available on this firmware)
    respx.get(
        "https://unifi.test:443/proxy/network/integration/v1/sites"
    ).respond(404)

    # Legacy login + endpoints succeed
    respx.post("https://unifi.test:443/api/auth/login").respond(200, json={})
    respx.get("https://unifi.test:443/proxy/network/api/s/default/stat/health").respond(
        200,
        json={"data": [{"subsystem": "wan", "wan_ip": "9.9.9.9", "isp_name": "Telekom"}]},
    )
    respx.get("https://unifi.test:443/proxy/network/api/s/default/stat/sta").respond(
        200, json={"data": []}
    )
    respx.get(
        "https://unifi.test:443/proxy/network/api/s/default/rest/networkconf"
    ).respond(200, json={"data": []})

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is True
    assert snap.auth_mode == "cookie"
    assert snap.wan_ip == "9.9.9.9"
    assert snap.isp == "Telekom"


@pytest.mark.asyncio
@respx.mock
async def test_integration_failure_with_no_legacy_creds_returns_diagnostic():
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_username="",
        unifi_password="",
    )
    respx.get(
        "https://unifi.test:443/proxy/network/integration/v1/sites"
    ).mock(side_effect=httpx.ConnectError("refused"))

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is False
    assert snap.auth_mode == "none"
    assert snap.error


@pytest.mark.asyncio
@respx.mock
async def test_site_lookup_by_name_finds_correct_site():
    """When multiple sites exist, the configured name must be used."""
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_site="home",
    )
    base = "https://unifi.test:443/proxy/network/integration/v1"
    home_uuid = "22222222-2222-2222-2222-222222222222"
    other_uuid = "33333333-3333-3333-3333-333333333333"

    respx.get(f"{base}/sites").respond(
        200,
        json={
            "data": [
                {"id": other_uuid, "name": "office"},
                {"id": home_uuid, "name": "home"},
            ]
        },
    )
    # Endpoints for the correct (home) site succeed.
    respx.get(f"{base}/sites/{home_uuid}/networks").respond(200, json={"data": []})
    respx.get(f"{base}/sites/{home_uuid}/clients").respond(200, json={"data": []})
    respx.get(f"{base}/sites/{home_uuid}/devices").respond(200, json={"data": []})

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is True
    assert snap.auth_mode == "api-key"
