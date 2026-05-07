#!/usr/bin/env python3
"""UniFi Integration API probe.

Dumps the raw responses for a battery of candidate endpoints so we can see
exactly which paths the controller exposes and what shape the bodies have.
Reads UNIFI_HOST / UNIFI_PORT / UNIFI_API_KEY from environment (or from the
.env file next to docker-compose.yml).

Run from the LXC:

    cd /opt/rxf-admin/backend
    python -m tools.probe_unifi

(or from the host if you have python+httpx)::

    UNIFI_HOST=192.168.2.1 UNIFI_API_KEY=xxxx python tools/probe_unifi.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

# Try to load .env files in known locations so the script "just works".
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

BASE = f"https://{HOST}:{PORT}"
HEADERS = {
    "X-API-KEY": KEY,
    "Accept": "application/json",
}

# Ordered list of candidate base paths to probe.
ROOTS = [
    "/proxy/network/integration/v1",   # most likely on current firmware
    "/proxy/network/integrations/v1",  # earlier preview path (plural)
    "/proxy/network/v2/api/site",      # newer experimental
    "/v1",                              # cloud-style fallback
]

# Endpoint suffixes to try once we have a working root.
PROBES = [
    "/sites",
    "/sites/{site}",
    "/sites/{site}/clients",
    "/sites/{site}/devices",
    "/sites/{site}/networks",
    "/sites/{site}/site-overview",
    "/sites/{site}/internet",
    "/sites/{site}/wan",
    "/sites/{site}/health",
    "/sites/{site}/stats",
]

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
    print(f"Auth header: X-API-KEY (length {len(KEY)})")
    print(f"Configured site: {SITE!r}")
    print(SEPARATOR)

    with httpx.Client(verify=VERIFY) as client:
        # Step 1: find a root that responds 2xx for /sites.
        chosen_root: str | None = None
        for root in ROOTS:
            url = f"{BASE}{root}/sites"
            status, ct, body = hit(client, url)
            print(f"GET  {url}")
            print(f"  -> status={status}  content-type={ct}")
            print(f"  body: {body[:400]}")
            print()
            if status == 200 and "json" in (ct or ""):
                chosen_root = root
                break

        if not chosen_root:
            print(SEPARATOR)
            print("No integration API root responded with JSON 200.")
            print("Possible reasons:")
            print("  - API key not yet activated (re-create in UniFi UI)")
            print("  - Firmware too old; integration API requires Network 8.x+")
            print("  - LXC cannot reach the controller (try: curl -k https://%s:%d/)" % (HOST, PORT))
            return 1

        print(SEPARATOR)
        print(f"Using root: {chosen_root}")
        print(SEPARATOR)

        # Step 2: extract a site id from /sites response.
        url = f"{BASE}{chosen_root}/sites"
        status, ct, body = hit(client, url)
        site_id = SITE
        try:
            parsed = json.loads(body if not body.endswith("truncated") else body.split("\n")[0])
            sites_list = parsed.get("data", parsed) if isinstance(parsed, dict) else parsed
            if isinstance(sites_list, list) and sites_list:
                first = sites_list[0]
                site_id = first.get("id") or first.get("siteId") or first.get("name") or SITE
                print(f"First site object keys: {list(first.keys())}")
                print(f"Using siteId: {site_id!r}")
        except (json.JSONDecodeError, ValueError, AttributeError):
            print(f"Could not parse /sites JSON; falling back to UNIFI_SITE={SITE!r}")
        print(SEPARATOR)

        # Step 3: probe each endpoint and dump.
        for suffix in PROBES:
            path = suffix.replace("{site}", str(site_id))
            url = f"{BASE}{chosen_root}{path}"
            status, ct, body = hit(client, url)
            print(f"GET  {chosen_root}{path}")
            print(f"  -> status={status}  content-type={ct}")
            print(f"  body: {body[:600]}")
            print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
