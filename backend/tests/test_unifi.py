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
    """Real response shapes observed on UniFi Network v10.3.58 (UCG-Ultra).

    Clients carry only `type` (WIRED/WIRELESS) and `uplinkDeviceId`, no VLAN
    membership. The gateway device exposes the public WAN IP under
    `ipAddress`. ISP / throughput / link speed are not in the integration API.
    """
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_site="Default",
    )
    base = "https://unifi.test:443/proxy/network/integration/v1"
    site_uuid = "11111111-1111-1111-1111-111111111111"
    gw_id = "gw-uuid"
    ap_id = "ap-uuid"

    respx.get(f"{base}/sites").respond(
        200,
        json={
            "data": [
                {"id": site_uuid, "name": "Default", "internalReference": "default"},
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/networks").respond(
        200,
        json={
            "data": [
                {"id": "n1", "name": "Default", "vlanId": 1, "enabled": True},
                {"id": "n2", "name": "IoT", "vlanId": 20, "enabled": True},
                {"id": "n3", "name": "Guest", "vlanId": 30, "enabled": True},
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/clients").respond(
        200,
        json={
            "data": [
                {"id": "c1", "type": "WIRED", "uplinkDeviceId": gw_id},
                {"id": "c2", "type": "WIRED", "uplinkDeviceId": gw_id},
                {"id": "c3", "type": "WIRELESS", "uplinkDeviceId": ap_id},
                {"id": "c4", "type": "WIRELESS", "uplinkDeviceId": ap_id},
                {"id": "c5", "type": "WIRELESS"},  # uplink unknown
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/devices").respond(
        200,
        json={
            "data": [
                {
                    "id": gw_id,
                    "name": "Cloud Gateway Ultra RX",
                    "model": "UCG Ultra",
                    "ipAddress": "93.221.213.49",
                    "state": "ONLINE",
                    "firmwareVersion": "5.0.16",
                },
                {
                    "id": ap_id,
                    "name": "U7 Lite",
                    "model": "U7 Lite",
                    "ipAddress": "192.168.2.22",
                    "state": "ONLINE",
                    "firmwareVersion": "8.5.21",
                },
            ]
        },
    )

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is True
    assert snap.auth_mode == "api-key"
    assert snap.wan_ip == "93.221.213.49"
    assert snap.clients_total == 5
    assert snap.clients_wired == 2
    assert snap.clients_wireless == 3
    # Networks are listed but client counts are 0 since the API doesn't
    # expose per-client VLAN membership in v10.3.
    by_name = {n.name: n for n in snap.networks}
    assert set(by_name) == {"Default", "IoT", "Guest"}
    assert by_name["IoT"].vlan == 20
    # Devices: gateway flagged, clients counted by uplink.
    by_dev = {d.id: d for d in snap.devices}
    assert by_dev[gw_id].is_gateway is True
    assert by_dev[gw_id].clients == 2
    assert by_dev[ap_id].is_gateway is False
    assert by_dev[ap_id].clients == 2
    assert by_dev[gw_id].model == "UCG Ultra"


def test_device_stats_parses_nested_statistics():
    """CPU/RAM/uptime live under `statistics`; ports under `interfaces.ports`."""
    detail = {
        "statistics": {
            "cpuUtilizationPct": 18.4,
            "memoryUtilizationPct": 42.1,
            "uptimeSec": 1987200,
        },
        "interfaces": {
            "ports": [
                {"state": "UP"},
                {"connected": True},
                {"state": "DOWN"},
                {"state": "DOWN"},
            ]
        },
    }
    stats = unifi._device_stats(detail)
    assert stats["cpu_pct"] == 18.4
    assert stats["mem_pct"] == 42.1
    assert stats["uptime_s"] == 1987200
    assert stats["ports_total"] == 4
    assert stats["ports_used"] == 2


def test_device_stats_tolerates_missing_fields():
    """A bare device object yields None/0 instead of raising."""
    stats = unifi._device_stats({})
    assert stats["cpu_pct"] is None
    assert stats["mem_pct"] is None
    assert stats["uptime_s"] == 0
    assert stats["ports_total"] is None
    assert stats["ports_used"] is None


@pytest.mark.asyncio
@respx.mock
async def test_integration_enriches_devices_with_detail_stats():
    """Device list is followed up with /devices/{id} detail calls for stats."""
    s = Settings(
        unifi_host="unifi.test",
        unifi_port=443,
        unifi_api_key="key123",
        unifi_site="Default",
    )
    base = "https://unifi.test:443/proxy/network/integration/v1"
    site_uuid = "44444444-4444-4444-4444-444444444444"
    gw_id = "gw-uuid"

    respx.get(f"{base}/sites").respond(
        200, json={"data": [{"id": site_uuid, "name": "Default"}]}
    )
    respx.get(f"{base}/sites/{site_uuid}/networks").respond(200, json={"data": []})
    respx.get(f"{base}/sites/{site_uuid}/clients").respond(200, json={"data": []})
    respx.get(f"{base}/sites/{site_uuid}/devices").respond(
        200,
        json={
            "data": [
                {
                    "id": gw_id,
                    "name": "Cloud Gateway Ultra RX",
                    "model": "UCG Ultra",
                    "ipAddress": "192.168.2.1",
                    "state": "ONLINE",
                }
            ]
        },
    )
    respx.get(f"{base}/sites/{site_uuid}/devices/{gw_id}").respond(
        200,
        json={
            "statistics": {
                "cpuUtilizationPct": 12.0,
                "memoryUtilizationPct": 40.0,
                "uptimeSec": 3600,
            },
            "interfaces": {"ports": [{"state": "UP"}, {"state": "DOWN"}]},
        },
    )

    snap = await unifi.fetch_network_snapshot(s)

    assert snap.reachable is True
    dev = snap.devices[0]
    assert dev.cpu_pct == 12.0
    assert dev.mem_pct == 40.0
    assert dev.uptime_s == 3600
    assert dev.ports_total == 2
    assert dev.ports_used == 1


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
