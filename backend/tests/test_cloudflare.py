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

    certs = await cloudflare.fetch_certs(settings)

    assert len(certs) == 1
    assert certs[0].domain == "example.test"
    assert certs[0].days_left <= 10
