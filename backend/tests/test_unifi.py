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
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_site="default",
    )
    base = "https://unifi.test:443/proxy/network/integration/v1"
    respx.get(f"{base}/sites").respond(
        200,
        json={
            "data": [
                {"id": "site1", "name": "default"},
            ]
        },
    )
    respx.get(f"{base}/sites/site1/site-overview").respond(
        200,
        json={
            "data": {
                "wan": {"ip": "1.2.3.4", "ispName": "Vodafone"},
                "networks": [
                    {"name": "LAN", "vlan": 1},
                    {"name": "IoT", "vlan": 30},
                ],
            }
        },
    )
    respx.get(f"{base}/sites/site1/clients").respond(
        200,
        json={
            "data": [
                {"vlan": 1},
                {"vlan": 1},
                {"vlan": 30},
            ]
        },
    )

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is True
    assert snap.auth_mode == "api-key"
    assert snap.wan_ip == "1.2.3.4"
    assert snap.isp == "Vodafone"
    assert snap.clients_total == 3
    by_name = {n.name: n for n in snap.networks}
    assert by_name["LAN"].clients == 2
    assert by_name["IoT"].clients == 1


@pytest.mark.asyncio
@respx.mock
async def test_integration_falls_back_to_legacy_when_no_root_responds():
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_username="admin",
        unifi_password="pass",
        unifi_site="default",
    )
    # All integration roots 404
    for root in unifi._INTEGRATION_ROOTS:
        respx.get(f"https://unifi.test:443{root}/sites").respond(404)
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
    for root in unifi._INTEGRATION_ROOTS:
        respx.get(f"https://unifi.test:443{root}/sites").mock(
            side_effect=httpx.ConnectError("refused")
        )

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is False
    assert snap.auth_mode == "none"
    assert snap.error
