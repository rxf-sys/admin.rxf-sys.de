from __future__ import annotations

import httpx
import pytest
import respx

from app.clients import geoip
from app.config import Settings


@pytest.mark.asyncio
async def test_disabled_returns_none():
    s = Settings(geoip_enabled=False)
    assert await geoip.fetch_isp(s, "1.2.3.4") is None


@pytest.mark.asyncio
async def test_empty_ip_returns_none():
    s = Settings(geoip_enabled=True)
    assert await geoip.fetch_isp(s, "") is None


@pytest.mark.asyncio
@respx.mock
async def test_strips_asn_prefix():
    """ipapi.co returns 'AS3320 Deutsche Telekom AG' — keep just the ISP name."""
    s = Settings(geoip_enabled=True)
    respx.get("https://ipapi.co/93.221.213.49/json/").respond(
        200, json={"org": "AS3320 Deutsche Telekom AG", "country": "DE"}
    )

    isp = await geoip.fetch_isp(s, "93.221.213.49")
    assert isp == "Deutsche Telekom AG"


@pytest.mark.asyncio
@respx.mock
async def test_keeps_org_when_no_asn_prefix():
    s = Settings(geoip_enabled=True)
    respx.get("https://ipapi.co/8.8.8.8/json/").respond(200, json={"org": "Google LLC"})

    isp = await geoip.fetch_isp(s, "8.8.8.8")
    assert isp == "Google LLC"


@pytest.mark.asyncio
@respx.mock
async def test_http_error_returns_none():
    s = Settings(geoip_enabled=True)
    respx.get("https://ipapi.co/1.2.3.4/json/").mock(
        side_effect=httpx.ConnectError("network down")
    )

    assert await geoip.fetch_isp(s, "1.2.3.4") is None


@pytest.mark.asyncio
@respx.mock
async def test_non_200_returns_none():
    s = Settings(geoip_enabled=True)
    respx.get("https://ipapi.co/1.2.3.4/json/").respond(429)

    assert await geoip.fetch_isp(s, "1.2.3.4") is None
