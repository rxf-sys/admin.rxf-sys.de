from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx

from app.clients import cloudflare

CF = "https://api.cloudflare.com/client/v4"


@pytest.mark.asyncio
@respx.mock
async def test_tunnel_status_unknown_on_error(settings):
    respx.get(
        f"{CF}/accounts/{settings.cf_account_id}/cfd_tunnel/{settings.cf_tunnel_id}"
    ).mock(side_effect=httpx.ConnectError("nope"))

    t = await cloudflare.fetch_tunnel_status(settings)

    assert t.status == "unknown"
    assert t.id == settings.cf_tunnel_id


@pytest.mark.asyncio
@respx.mock
async def test_tunnel_status_healthy(settings):
    respx.get(
        f"{CF}/accounts/{settings.cf_account_id}/cfd_tunnel/{settings.cf_tunnel_id}"
    ).respond(
        200,
        json={
            "success": True,
            "result": {"name": "rxf-tunnel", "status": "healthy"},
        },
    )
    respx.get(
        f"{CF}/accounts/{settings.cf_account_id}/cfd_tunnel/{settings.cf_tunnel_id}/connections"
    ).respond(
        200,
        json={
            "success": True,
            "result": [
                {"client_version": "2024.10.0", "conns": [{"colo_name": "fra06"}]},
                {"client_version": "2024.10.0", "conns": [{"colo_name": "fra08"}]},
            ],
        },
    )

    t = await cloudflare.fetch_tunnel_status(settings)

    assert t.status == "healthy"
    assert t.connections == 2
    assert "fra06" in t.regions and "fra08" in t.regions
    assert t.cloudflared_version == "2024.10.0"


@pytest.mark.asyncio
@respx.mock
async def test_tunnel_status_retries_on_rate_limit(settings, monkeypatch):
    # Make backoff sleeps no-ops so the test stays fast.
    import asyncio as _asyncio

    async def _fake_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(_asyncio, "sleep", _fake_sleep)

    tunnel_url = f"{CF}/accounts/{settings.cf_account_id}/cfd_tunnel/{settings.cf_tunnel_id}"
    route = respx.get(tunnel_url).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0"}),
            httpx.Response(200, json={"success": True, "result": {"status": "healthy"}}),
        ]
    )
    respx.get(f"{tunnel_url}/connections").respond(
        200, json={"success": True, "result": []}
    )

    t = await cloudflare.fetch_tunnel_status(settings)

    assert route.call_count == 2
    assert t.status == "healthy"


@pytest.mark.asyncio
@respx.mock
async def test_certs_dedupes_and_sorts(settings):
    soon = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat().replace("+00:00", "Z")
    later = (datetime.now(timezone.utc) + timedelta(days=80)).isoformat().replace("+00:00", "Z")
    respx.get(f"{CF}/zones/{settings.cf_zone_id}/ssl/certificate_packs").respond(
        200,
        json={
            "success": True,
            "result": [
                {
                    "hosts": ["example.test"],
                    "certificate_authority": "lets_encrypt",
                    "certificates": [
                        {"hosts": ["example.test"], "issuer": "Let's Encrypt", "expires_on": soon},
                        {"hosts": ["example.test"], "issuer": "Let's Encrypt", "expires_on": later},
                    ],
                }
            ],
        },
    )

    certs, error = await cloudflare.fetch_certs(settings)

    assert error is None
    assert len(certs) == 1
    assert certs[0].domain == "example.test"
    assert certs[0].days_left <= 10


@pytest.mark.asyncio
async def test_zone_analytics_no_token_returns_empty(settings):
    s = settings.model_copy(update={"cf_api_token": "", "cf_zone_id": "z"})
    a = await cloudflare.fetch_zone_analytics(s, minutes=60)
    assert a["reachable"] is False
    assert a["requests_total"] == 0
    assert a["series"] == []


@pytest.mark.asyncio
@respx.mock
async def test_zone_analytics_aggregates_totals(settings):
    """GraphQL httpRequestsAdaptiveGroups returns one row per minute per
    cacheStatus; the helper folds them into totals + cache-hit %."""
    respx.post(f"{CF}/graphql").mock(return_value=httpx.Response(
        200,
        json={
            "data": {
                "viewer": {
                    "zones": [
                        {
                            "httpRequestsAdaptiveGroups": [
                                {
                                    "count": 600,
                                    "sum": {"edgeResponseBytes": 3_000_000},
                                    "dimensions": {"datetimeMinute": "2026-05-30T10:00:00Z", "cacheStatus": "hit"},
                                },
                                {
                                    "count": 200,
                                    "sum": {"edgeResponseBytes": 1_500_000},
                                    "dimensions": {"datetimeMinute": "2026-05-30T10:00:00Z", "cacheStatus": "miss"},
                                },
                                {
                                    "count": 400,
                                    "sum": {"edgeResponseBytes": 500_000},
                                    "dimensions": {"datetimeMinute": "2026-05-30T10:01:00Z", "cacheStatus": "hit"},
                                },
                            ]
                        }
                    ]
                }
            }
        },
    ))

    a = await cloudflare.fetch_zone_analytics(settings, minutes=60)
    assert a["reachable"] is True
    assert a["requests_total"] == 1200
    assert a["requests_per_min"] == 20.0
    # 1000 of 1200 are cached (hit) → 83.3%
    assert a["cache_hit_pct"] == 83.3
    assert a["bandwidth_b"] == 5_000_000
    # Two minute buckets, one with 800 (hit+miss collapsed), one with 400.
    assert len(a["series"]) == 2
    assert a["series"][0]["all"] == 800
    assert a["series"][1]["all"] == 400


@pytest.mark.asyncio
@respx.mock
async def test_zone_analytics_graphql_error_surfaces(settings):
    respx.post(f"{CF}/graphql").mock(return_value=httpx.Response(
        200,
        json={"data": None, "errors": [{"message": "zone not found"}]},
    ))

    a = await cloudflare.fetch_zone_analytics(settings, minutes=60)
    assert a["reachable"] is False
    assert "zone not found" in (a["error"] or "")


@pytest.mark.asyncio
@respx.mock
async def test_zone_analytics_http_error_surfaces_as_unreachable(settings):
    respx.post(f"{CF}/graphql").mock(side_effect=httpx.ConnectError("no route"))

    a = await cloudflare.fetch_zone_analytics(settings, minutes=60)
    assert a["reachable"] is False
    assert a["error"]
    assert a["requests_total"] == 0
