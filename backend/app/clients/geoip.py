"""IP geolocation lookup.

Used to fill in the ISP name when the UniFi controller doesn't expose it
(the Integration API up to v10.3 does not, only the legacy cookie API does).

Uses ipapi.co's free tier (1000 req/day, HTTPS, no auth required). Result is
cached for several hours since ISP info changes very rarely.

Sends only the configured public WAN IP to the third party. That IP is
already publicly visible to every site you browse, so this is not a
privacy regression — but the lookup can be disabled by leaving
``settings.geoip_enabled = False`` in the .env.
"""

from __future__ import annotations

import httpx
import structlog

from ..config import Settings

log = structlog.get_logger("geoip")

_PROVIDER_URL = "https://ipapi.co/{ip}/json/"


async def fetch_isp(settings: Settings, ip: str) -> str | None:
    """Look up the ISP name for a public IP. Returns None on any failure."""
    if not settings.geoip_enabled or not ip:
        return None

    url = _PROVIDER_URL.format(ip=ip)
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(url, headers={"Accept": "application/json"})
            if r.status_code != 200:
                log.info("geoip.non_200", ip=ip, status=r.status_code)
                return None
            data = r.json()
    except httpx.HTTPError as e:
        log.info("geoip.failed", ip=ip, error=str(e))
        return None
    except ValueError:
        log.info("geoip.non_json", ip=ip)
        return None

    # ipapi.co returns "org" as "AS3320 Deutsche Telekom AG" — strip the ASN.
    org = data.get("org") or ""
    if isinstance(org, str) and org.startswith("AS") and " " in org:
        org = org.split(" ", 1)[1]
    return org or None
