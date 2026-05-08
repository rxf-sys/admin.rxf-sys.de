#!/usr/bin/env python3
"""UniFi Integration API probe (stdlib only).

Hits each documented endpoint of the official UniFi Network Integration API
(developer.ui.com, v10.x) and dumps the raw responses so we can see what
shapes the controller actually returns.

Uses only Python's stdlib (http.client + ssl) so it runs on any LXC without
extra packages. Ignores TLS verification by default to handle self-signed
certs on local controllers.

Reads UNIFI_HOST / UNIFI_PORT / UNIFI_API_KEY / UNIFI_SITE / UNIFI_VERIFY_TLS
from environment, falling back to .env files in standard locations.

Run from the LXC host (no container needed)::

    cd /opt/rxf-admin/backend
    python3 tools/probe_unifi.py

Or inside the backend container after the next rebuild::

    docker compose exec backend python -m tools.probe_unifi
"""

from __future__ import annotations

import http.client
import json
import os
import ssl
import sys
from pathlib import Path

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
BASE_PATH = "/proxy/network/integration/v1"
HEADERS = {"X-API-Key": KEY, "Accept": "application/json"}

SEPARATOR = "─" * 78


def _make_conn() -> http.client.HTTPSConnection:
    if VERIFY:
        ctx = ssl.create_default_context()
    else:
        ctx = ssl._create_unverified_context()
    return http.client.HTTPSConnection(HOST, PORT, context=ctx, timeout=8)


def hit(path: str) -> tuple[int, str, str]:
    full = f"{BASE_PATH}{path}"
    conn = _make_conn()
    try:
        try:
            conn.request("GET", full, headers=HEADERS)
        except OSError as e:
            return -1, "", f"{type(e).__name__}: {e}"
        resp = conn.getresponse()
        ct = resp.headers.get("content-type", "") or ""
        body_bytes = resp.read()
        try:
            body = body_bytes.decode("utf-8", errors="replace")
        except UnicodeDecodeError:
            body = repr(body_bytes[:500])
        if len(body) > 1500:
            body = body[:1500] + f"\n   … truncated ({len(body_bytes)} bytes total)"
        return resp.status, ct, body
    finally:
        conn.close()


def main() -> int:
    print(f"Probing UniFi at https://{HOST}:{PORT}{BASE_PATH}")
    print(f"Auth header: X-API-Key (length {len(KEY)})")
    print(f"Configured site: {SITE!r}")
    print(f"TLS verify: {VERIFY}")
    print(SEPARATOR)

    # /info — should return controller version + features
    status, ct, body = hit("/info")
    print("GET  /info")
    print(f"  -> status={status}  content-type={ct}")
    print(f"  body: {body[:400]}")
    print()

    # /sites — extract a siteId from this
    status, ct, body = hit("/sites")
    print("GET  /sites")
    print(f"  -> status={status}  content-type={ct}")
    print(f"  body: {body[:600]}")
    print()

    if status != 200 or "json" not in ct.lower():
        print(SEPARATOR)
        print("Cannot continue: /sites did not return JSON 200.")
        print("Possible reasons:")
        print("  - API key invalid or not yet activated")
        print("  - Firmware too old (Integration API needs Network 8.x+)")
        print("  - LXC cannot reach the controller — try:")
        print(f"      curl -k https://{HOST}:{PORT}/")
        return 1

    site_id = SITE
    try:
        # Strip the truncation marker if any so json.loads succeeds.
        clean = body.split("\n", 1)[0] if "truncated" in body else body
        parsed = json.loads(clean)
        sites_list = parsed.get("data", parsed) if isinstance(parsed, dict) else parsed
        if isinstance(sites_list, list) and sites_list:
            first = sites_list[0]
            if isinstance(first, dict):
                site_id = first.get("id") or first.get("name") or SITE
                print(f"First site object keys: {list(first.keys())}")
                print(f"Using siteId: {site_id!r}")
    except (json.JSONDecodeError, ValueError, AttributeError):
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
        status, ct, body = hit(path)
        print(f"GET  {path}")
        print(f"  -> status={status}  content-type={ct}")
        print(f"  body: {body[:600]}")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
