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
async def test_happy_path_extracts_ism_sample_real_shape():
    """Matches the shape documented at developer.ui.com/site-manager-api:

        data[].periods[].data.wan = { avgLatency, packetLoss,
                                      download_kbps, upload_kbps, ispName, ... }

    The previous version assumed metrics lived at the top of the period;
    this test enforces the real, nested layout.
    """
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(
        200,
        json={
            "data": [
                {
                    "id": "host-1",
                    "reportedState": {"hostname": "rxf-ucg.ui.com", "name": "Cloud Gateway"},
                    "userData": {},
                },
                {"id": "host-2", "reportedState": {"hostname": "other.ui.com"}},
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
                    "metricType": "5m",
                    "siteId": "site-aaa",
                    "hostId": "host-1",
                    "periods": [
                        {
                            "metricTime": "2026-06-08T10:55:00Z",
                            "version": "1",
                            "data": {
                                "wan": {
                                    "avgLatency": 12,
                                    "maxLatency": 18,
                                    "packetLoss": 0,
                                    "uptime": 100,
                                    "downtime": 0,
                                    "download_kbps": 942_000,
                                    "upload_kbps": 48_000,
                                    "ispName": "Vodafone",
                                    "ispAsn": "12578",
                                }
                            },
                        },
                        {
                            "metricTime": "2026-06-08T11:00:00Z",
                            "version": "1",
                            "data": {
                                "wan": {
                                    "avgLatency": 14,
                                    "packetLoss": 0,
                                    "download_kbps": 953_000,
                                    "upload_kbps": 49_000,
                                    "ispName": "Vodafone",
                                    "ispAsn": "12578",
                                }
                            },
                        },
                    ],
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    # Latest sample wins (11:00, not 10:55).
    assert metric["latency_ms"] == 14
    assert metric["download_mbit"] == 953.0
    assert metric["upload_mbit"] == 49.0
    assert metric["isp_name"] == "Vodafone"
    assert metric["isp_asn"] == "12578"
    assert metric["packet_loss_pct"] == 0
    assert metric["host_name"] == "rxf-ucg.ui.com"


@pytest.mark.asyncio
@respx.mock
async def test_extracts_max_latency_and_leaves_jitter_none():
    """ISM exposes maxLatency (peak) but no jitter field. We surface
    max_latency_ms and leave jitter_ms None rather than inventing it."""
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE
    respx.get(f"{base}/hosts").respond(200, json={"data": [{"id": "h"}]})
    respx.get(f"{base}/sites").respond(200, json={"data": [{"siteId": "s"}]})
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "periods": [
                        {
                            "data": {
                                "wan": {
                                    "avgLatency": 7,
                                    "maxLatency": 23,
                                    "packetLoss": 0,
                                    "ispName": "Telekom",
                                }
                            }
                        }
                    ]
                }
            ]
        },
    )
    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["latency_ms"] == 7
    assert metric["max_latency_ms"] == 23
    assert metric["jitter_ms"] is None


@pytest.mark.asyncio
@respx.mock
async def test_skips_empty_period_falls_back_to_last_real_one():
    """Some firmware drops an empty placeholder period at the head of the
    chronological array. Walk backwards until we find a real sample."""
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(200, json={"data": [{"id": "h"}]})
    respx.get(f"{base}/sites").respond(200, json={"data": [{"siteId": "s"}]})
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "periods": [
                        {"metricTime": "T0", "data": {"wan": {"avgLatency": 10, "ispName": "X"}}},
                        {"metricTime": "T1", "data": {"wan": {}}},
                    ]
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["latency_ms"] == 10
    assert metric["isp_name"] == "X"


@pytest.mark.asyncio
@respx.mock
async def test_supports_flat_wan_layout():
    """Older firmware emits period.wan directly without the data wrapper."""
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(200, json={"data": [{"id": "h"}]})
    respx.get(f"{base}/sites").respond(200, json={"data": [{"siteId": "s"}]})
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "periods": [
                        {
                            "metricTime": "T",
                            "wan": {"avgLatency": 7, "downloadMbps": 500, "ispName": "Z"},
                        }
                    ]
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["latency_ms"] == 7
    assert metric["download_mbit"] == 500.0
    assert metric["isp_name"] == "Z"


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
async def test_filters_by_configured_host_id_and_uses_userdata_alias():
    s = Settings(
        unifi_site_manager_api_key="abc123",
        unifi_site_manager_host_id="host-2",
    )
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(
        200,
        json={
            "data": [
                {"id": "host-1", "reportedState": {"hostname": "wrong"}},
                {
                    "id": "host-2",
                    "userData": {"alias": "rxf-prod"},
                    "reportedState": {"hostname": "fallback"},
                },
            ]
        },
    )
    respx.get(f"{base}/sites").respond(200, json={"data": [{"siteId": "s"}]})
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "periods": [
                        {"data": {"wan": {"avgLatency": 5, "ispName": "ISP-X"}}},
                    ]
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    # userData.alias wins over reportedState.hostname for the badge.
    assert metric["host_name"] == "rxf-prod"
    assert metric["isp_name"] == "ISP-X"


@pytest.mark.asyncio
@respx.mock
async def test_drops_negative_sentinel_values():
    """UI sometimes uses -1 as the "no data" marker for latency / loss."""
    s = Settings(unifi_site_manager_api_key="abc123")
    base = unifi_remote.API_BASE

    respx.get(f"{base}/hosts").respond(200, json={"data": [{"id": "h"}]})
    respx.get(f"{base}/sites").respond(200, json={"data": [{"siteId": "s"}]})
    respx.get(f"{base}/isp-metrics/5m").respond(
        200,
        json={
            "data": [
                {
                    "periods": [
                        {
                            "data": {
                                "wan": {
                                    "avgLatency": -1,
                                    "packetLoss": -1,
                                    "ispName": "ISP",
                                    "download_kbps": 1000,
                                }
                            }
                        }
                    ]
                }
            ]
        },
    )

    metric = await unifi_remote.fetch_isp_metrics(s)
    assert metric is not None
    assert metric["latency_ms"] is None
    assert metric["packet_loss_pct"] is None
    assert metric["isp_name"] == "ISP"
    assert metric["download_mbit"] == 1.0
