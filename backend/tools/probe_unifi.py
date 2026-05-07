#!/usr/bin/env python3
"""UniFi Integration API probe.

Hits each documented endpoint of the official UniFi Network Integration API
(developer.ui.com, v10.x) and dumps the raw responses so we can see what
shapes the controller actually returns. Useful when adapting the live client
to a different firmware revision.

Reads UNIFI_HOST / UNIFI_PORT / UNIFI_API_KEY / UNIFI_SITE / UNIFI_VERIFY_TLS
from environment, falling back to .env files in standard locations.

Run from the LXC::

    cd /opt/rxf-admin
    docker compose exec backend python -m tools.probe_unifi

Or directly on a machine with httpx::

    UNIFI_HOST=192.168.2.1 UNIFI_API_KEY=xxx python tools/probe_unifi.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

_SEARCH_PATHS = [
    Path.cwd() / ".env",
    Path.cwd().parent / "infrastructure" / ".env",
    Path("/opt/rxf-admin/infrastructure/.env"),
]
for p in _SEARCH_PATHS:
    if not p.exists():
        continue
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    break


HOST = os.environ.get("UNIFI_HOST", "192.168.2.1")
PORT = int(os.environ.get("UNIFI_PORT", "443"))
KEY = os.environ.get("UNIFI_API_KEY", "")
SITE = os.environ.get("UNIFI_SITE", "default")
VERIFY = os.environ.get("UNIFI_VERIFY_TLS", "false").lower() == "true"

if not KEY:
    print("ERROR: UNIFI_API_KEY is empty. Set it in env or .env first.", file=sys.stderr)
    sys.exit(2)

# Per developer.ui.com (Local connection type, Network v10.1.84):
BASE = f"https://{HOST}:{PORT}/proxy/network/integration/v1"
HEADERS = {"X-API-Key": KEY, "Accept": "application/json"}

SEPARATOR = "─" * 78


def hit(client: httpx.Client, url: str) -> tuple[int, str, str]:
    try:
        r = client.get(url, headers=HEADERS, timeout=8.0)
    except httpx.HTTPError as e:
        return -1, "", f"{type(e).__name__}: {e}"
    body = r.text
    if len(body) > 1500:
        body = body[:1500] + f"\n   … truncated ({len(r.text)} bytes total)"
    return r.status_code, dict(r.headers).get("content-type", ""), body


def main() -> int:
    print(f"Probing UniFi at {BASE}")
    print(f"Auth header: X-API-Key (length {len(KEY)})")
    print(f"Configured site: {SITE!r}")
    print(SEPARATOR)

    with httpx.Client(verify=VERIFY) as client:
        # /info — should return controller version + features
        url = f"{BASE}/info"
        status, ct, body = hit(client, url)
        print("GET  /info")
        print(f"  -> status={status}  content-type={ct}")
        print(f"  body: {body[:400]}")
        print()

        # /sites — must work; we extract a siteId from this
        url = f"{BASE}/sites"
        status, ct, body = hit(client, url)
        print("GET  /sites")
        print(f"  -> status={status}  content-type={ct}")
        print(f"  body: {body[:600]}")
        print()

        if status != 200 or "json" not in (ct or ""):
            print(SEPARATOR)
            print("Cannot continue: /sites did not return JSON 200.")
            print("Possible reasons:")
            print("  - API key invalid or not yet activated")
            print("  - Firmware too old (Integration API needs Network 8.x+)")
            print("  - LXC cannot reach the controller — try:")
            print(f"      curl -k https://{HOST}:{PORT}/")
            return 1

        try:
            parsed = json.loads(body if not body.endswith("truncated") else body.split("\n")[0])
            sites_list = parsed.get("data", parsed) if isinstance(parsed, dict) else parsed
            site_id = SITE
            if isinstance(sites_list, list) and sites_list:
                first = sites_list[0]
                site_id = first.get("id") or first.get("name") or SITE
                print(f"First site object keys: {list(first.keys())}")
                print(f"Using siteId: {site_id!r}")
        except (json.JSONDecodeError, ValueError, AttributeError):
            site_id = SITE
            print(f"Could not parse /sites JSON; falling back to UNIFI_SITE={SITE!r}")
        print(SEPARATOR)

        # Documented endpoints we want to inspect
        for path in [
            f"/sites/{site_id}",
            f"/sites/{site_id}/networks",
            f"/sites/{site_id}/clients",
            f"/sites/{site_id}/devices",
            f"/sites/{site_id}/wlans",  # WiFi Broadcasts
        ]:
            url = f"{BASE}{path}"
            status, ct, body = hit(client, url)
            print(f"GET  {path}")
            print(f"  -> status={status}  content-type={ct}")
            print(f"  body: {body[:600]}")
            print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
