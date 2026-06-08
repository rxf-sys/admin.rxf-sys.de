from __future__ import annotations

import httpx
import pytest
import respx

from app.clients import unifi_remote
from app.config import Settings


@pytest.mark.asyncio
async def test_disabled_when_no_key():
    s = Settings(unifi_site_manager_api_key="")
    assert await unifi_remote.fetch_isp_metrics(s) is None


@pytest.mark.asyncio
@respx.mock
async def test_happy_path_extracts_ism_sample():
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(
        200,
        json={
            "data": [
                {"id": "host-1", "reportedState": {"name": "rxf-ucg"}},
                {"id": "host-2", "reportedState": {"name": "other"}},
            ]
        },
    )
    respx.get(f"{base}/sites").respond(
        200,
        json={"data": [{"siteId": "site-aaa", "hostId": "host-1"}]},
    )
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "timestamp": "2026-06-08T11:00:00Z",
                    "metrics": {
                        "isp": "Vodafone",
                        "wanIp": "1.2.3.4",
                        "wan": {
                            "avgLatency": 12.4,
                            "avgJitter": 1.7,
                            "avgPacketLoss": 0.0,
                            "download": 942.3,
                            "upload": 48.1,
                        },
                    },
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["isp_name"] == "Vodafone"
    assert metric["public_ip"] == "1.2.3.4"
    assert metric["latency_ms"] == pytest.approx(12.4)
    assert metric["jitter_ms"] == pytest.approx(1.7)
    assert metric["packet_loss_pct"] == pytest.approx(0.0)
    assert metric["download_mbit"] == pytest.approx(942.3)
    assert metric["upload_mbit"] == pytest.approx(48.1)
    assert metric["host_name"] == "rxf-ucg"


@pytest.mark.asyncio
@respx.mock
async def test_normalises_kbps_to_mbit():
    """Some firmware reports download/upload in Kbps even though the field
    name implies Mbps. _normalise_speed flips anything > 10 000 to Mbit."""
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(200, json={"data": [{"id": "h"}]})
    respx.get(f"{base}/sites").respond(200, json={"data": [{"siteId": "s"}]})
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "metrics": {
                        "wan": {"download": 950_000, "upload": 50_000},
                    }
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["download_mbit"] == 950.0
    assert metric["upload_mbit"] == 50.0


@pytest.mark.asyncio
@respx.mock
async def test_returns_none_on_no_hosts():
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE
    respx.get(f"{base}/hosts").respond(200, json={"data": []})

    assert await unifi_remote.fetch_isp_metrics(s) is None


@pytest.mark.asyncio
@respx.mock
async def test_returns_none_on_http_error():
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE
    respx.get(f"{base}/hosts").mock(side_effect=httpx.ConnectError("nope"))

    assert await unifi_remote.fetch_isp_metrics(s) is None


@pytest.mark.asyncio
@respx.mock
async def test_filters_by_configured_host_id():
    s = Settings(
        unifi_site_manager_api_key="abc123",
        unifi_site_manager_host_id="host-2",
    )
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(
        200,
        json={
            "data": [
                {"id": "host-1", "reportedState": {"name": "wrong"}},
                {"id": "host-2", "reportedState": {"name": "right"}},
            ]
        },
    )
    respx.get(f"{base}/sites").respond(
        200, json={"data": [{"siteId": "s"}]}
    )
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={"data": [{"metrics": {"isp": "ISP-X", "wan": {"avgLatency": 5}}}]},
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["host_name"] == "right"
    assert metric["isp_name"] == "ISP-X"
