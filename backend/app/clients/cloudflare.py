from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import structlog

from ..config import Settings
from ..models import CertInfo, DNSRecordCheck, TunnelStatus

log = structlog.get_logger("cloudflare")

CF_API = "https://api.cloudflare.com/client/v4"

# Subdomains expected to CNAME to <tunnel_id>.cfargotunnel.com.
# Note: this list used to drive the DNS-consistency check (Cloudflare must
# have a CNAME for each of these hostnames). It is no longer consulted —
# fetch_dns_consistency now returns *every* record in the zone. Kept here
# for reference; can be deleted once the registry is the canonical source
# of "expected hostnames".
_DEPRECATED_EXPECTED_TUNNEL_SUBS = ["vault", "cloud", "photos", "docs", "media", "ha", "monitor", "pbs"]


def _auth(settings: Settings) -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.cf_api_token}"}


_RETRY_STATUSES = {429, 500, 502, 503, 504}


async def _get_raw(client: httpx.AsyncClient, settings: Settings, path: str) -> dict:
    """GET with exponential backoff on 429/5xx (max 3 attempts: 0.5s, 1s).

    Returns the full decoded body so callers that need ``result_info`` (for
    pagination) can read it. Use :func:`_get` for the common case where only
    ``result`` matters.
    """
    import asyncio

    delay = 0.5
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            r = await client.get(f"{CF_API}{path}", headers=_auth(settings))
        except httpx.HTTPError as e:
            last_exc = e
            if attempt == 2:
                raise
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if r.status_code in _RETRY_STATUSES and attempt < 2:
            log.info("cloudflare.retry", path=path, status=r.status_code, attempt=attempt + 1)
            retry_after = r.headers.get("Retry-After")
            wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
            await asyncio.sleep(min(wait, 5.0))
            delay *= 2
            continue
        r.raise_for_status()
        body = r.json()
        if not body.get("success", False):
            raise httpx.HTTPError(f"CF API error: {body.get('errors')}")
        return body
    if last_exc:
        raise last_exc
    raise httpx.HTTPError(f"CF API exhausted retries for {path}")


async def _get(client: httpx.AsyncClient, settings: Settings, path: str) -> dict | list:
    body = await _get_raw(client, settings, path)
    return body.get("result", {})


async def _get_paginated(
    client: httpx.AsyncClient, settings: Settings, path: str, per_page: int = 100
) -> list:
    """List endpoints with ``result_info.total_pages``. Caller passes the path
    *without* ``page`` / ``per_page`` — we append them and walk all pages."""
    sep = "&" if "?" in path else "?"
    items: list = []
    page = 1
    while True:
        body = await _get_raw(
            client, settings, f"{path}{sep}page={page}&per_page={per_page}"
        )
        result = body.get("result")
        if isinstance(result, list):
            items.extend(result)
        info = body.get("result_info") or {}
        total_pages = int(info.get("total_pages", 1) or 1)
        if page >= total_pages or not isinstance(result, list) or not result:
            break
        page += 1
        if page > 50:  # hard ceiling to avoid runaway loops
            log.warning("cloudflare.pagination_ceiling", path=path)
            break
    return items


async def fetch_tunnel_status(settings: Settings) -> TunnelStatus:
    if not (settings.cf_api_token and settings.cf_account_id and settings.cf_tunnel_id):
        return TunnelStatus(
            reachable=False,
            error="CF_API_TOKEN, CF_ACCOUNT_ID oder CF_TUNNEL_ID nicht konfiguriert",
        )
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            tunnel = await _get(
                client,
                settings,
                f"/accounts/{settings.cf_account_id}/cfd_tunnel/{settings.cf_tunnel_id}",
            )
            conns = await _get(
                client,
                settings,
                f"/accounts/{settings.cf_account_id}/cfd_tunnel/{settings.cf_tunnel_id}/connections",
            )
        except httpx.HTTPError as e:
            log.warning(
                "cloudflare.tunnel_failed",
                tunnel_id=settings.cf_tunnel_id,
                error=str(e),
                error_type=type(e).__name__,
            )
            return TunnelStatus(
                id=settings.cf_tunnel_id,
                status="unknown",
                reachable=False,
                error=f"Cloudflare-API nicht erreichbar: {type(e).__name__}",
            )

    raw_status = (tunnel.get("status") if isinstance(tunnel, dict) else None) or "unknown"
    mapped = {"healthy": "healthy", "degraded": "degraded", "down": "down", "inactive": "down"}.get(
        raw_status, "unknown"
    )
    regions: list[str] = []
    versions: set[str] = set()
    if isinstance(conns, list):
        for c in conns:
            for cc in c.get("conns", []) or []:
                if loc := cc.get("colo_name"):
                    regions.append(loc)
            if v := c.get("client_version"):
                versions.add(v)

    return TunnelStatus(
        id=settings.cf_tunnel_id,
        name=tunnel.get("name") if isinstance(tunnel, dict) else None,
        status=mapped,  # type: ignore[arg-type]
        connections=len(conns) if isinstance(conns, list) else 0,
        regions=sorted(set(regions)),
        cloudflared_version=next(iter(sorted(versions, reverse=True)), None),
    )


async def fetch_wan_ip() -> str | None:
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            r = await client.get("https://api.ipify.org?format=json")
            r.raise_for_status()
            return r.json().get("ip")
        except httpx.HTTPError:
            return None


async def fetch_certs(settings: Settings) -> tuple[list[CertInfo], str | None]:
    """Return ``(certs, error)``. ``error`` is None on success, otherwise a
    human-readable reason (unconfigured / API unreachable)."""
    if not (settings.cf_api_token and settings.cf_zone_id):
        return [], "CF_API_TOKEN oder CF_ZONE_ID nicht konfiguriert"
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            packs = await _get(client, settings, f"/zones/{settings.cf_zone_id}/ssl/certificate_packs")
        except httpx.HTTPError as e:
            log.warning("cloudflare.certs_failed", zone=settings.cf_zone_id, error=str(e))
            return [], f"Cloudflare-API nicht erreichbar: {type(e).__name__}"
    out: list[CertInfo] = []
    now = datetime.now(timezone.utc)
    if isinstance(packs, list):
        for p in packs:
            for cert in p.get("certificates", []) or []:
                expires = cert.get("expires_on")
                if not expires:
                    continue
                try:
                    exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
                except ValueError:
                    continue
                # Prefer the per-certificate hosts; fall back to the pack's
                # hosts (may be empty) and finally to a sentinel.
                hosts = cert.get("hosts") or p.get("hosts") or ["?"]
                for host in hosts:
                    out.append(
                        CertInfo(
                            domain=host,
                            issuer=cert.get("issuer", p.get("certificate_authority", "Cloudflare")),
                            days_left=max(0, (exp_dt - now).days),
                        )
                    )
    # de-dup by (domain, issuer), keep min days_left
    dedup: dict[tuple[str, str], CertInfo] = {}
    for c in out:
        key = (c.domain, c.issuer)
        if key not in dedup or dedup[key].days_left > c.days_left:
            dedup[key] = c
    return sorted(dedup.values(), key=lambda c: c.days_left), None


CACHED_STATES = {"hit", "stale", "revalidated", "updating"}


def _empty_analytics(minutes: int, reachable: bool, error: str | None) -> dict:
    return {
        "reachable": reachable,
        "error": error,
        "minutes": minutes,
        "requests_total": 0,
        "requests_per_min": 0.0,
        "cache_hit_pct": None,
        "threats_total": 0,
        "bandwidth_b": 0,
        "series": [],
    }


async def fetch_zone_analytics(settings: Settings, minutes: int = 60) -> dict:
    """Pull request + cache counters for the zone via the GraphQL Analytics
    API (``httpRequestsAdaptiveGroups``). Works on Free Plan; the legacy
    REST ``/zones/{id}/analytics/dashboard`` endpoint was retired for
    Free/lower-tier zones around 2023.

    The query asks for minute-bucketed groups split by cacheStatus over the
    last N minutes (capped at 1440 = 24h). We aggregate locally to derive
    requests/min average + cache-hit %, and emit one timeseries point per
    minute for the sparkline.

    Token scope required: ``Zone -> Analytics: Read``. Threats are not
    queried — ``firewallEventsAdaptive`` is gated on Pro+ in practice and
    Free returns mostly empty results."""
    if not (settings.cf_api_token and settings.cf_zone_id):
        return _empty_analytics(minutes, False, "CF_API_TOKEN oder CF_ZONE_ID nicht gesetzt")

    window_min = max(1, min(minutes, 1440))
    end_dt = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start_dt = end_dt - timedelta(minutes=window_min)
    # GraphQL needs an ISO-8601 UTC string, second precision.
    iso = "%Y-%m-%dT%H:%M:%SZ"
    query = (
        "query($zone: String!, $start: Time!, $end: Time!) {"
        "  viewer { zones(filter: {zoneTag: $zone}) {"
        "    httpRequestsAdaptiveGroups("
        "      limit: 5000,"
        "      filter: {datetime_geq: $start, datetime_lt: $end},"
        "      orderBy: [datetimeMinute_ASC]"
        "    ) {"
        "      count"
        "      sum { edgeResponseBytes }"
        "      dimensions { datetimeMinute cacheStatus }"
        "    }"
        "  } }"
        "}"
    )
    payload = {
        "query": query,
        "variables": {
            "zone": settings.cf_zone_id,
            "start": start_dt.strftime(iso),
            "end": end_dt.strftime(iso),
        },
    }
    async with httpx.AsyncClient(verify=True, timeout=12.0) as client:
        try:
            r = await client.post(
                f"{CF_API}/graphql", headers=_auth(settings), json=payload
            )
            r.raise_for_status()
            body = r.json()
        except httpx.HTTPError as e:
            msg = str(e)
            short = msg if len(msg) <= 140 else msg[:140] + "…"
            if "403" in msg or "Forbidden" in msg:
                short = "Token-Scope unzureichend — 'Zone · Analytics: Read' fehlt."
            return _empty_analytics(window_min, False, short)
        except ValueError as e:
            return _empty_analytics(window_min, False, f"GraphQL-Antwort unparsbar: {e}")

    # GraphQL errors land in body["errors"], not as HTTP non-2xx.
    if isinstance(body.get("errors"), list) and body["errors"]:
        msg = str(body["errors"][0].get("message", "GraphQL-Fehler"))
        return _empty_analytics(window_min, False, msg[:140])

    try:
        groups = body["data"]["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]
    except (KeyError, IndexError, TypeError):
        return _empty_analytics(window_min, True, None)

    requests_total = 0
    cached_total = 0
    bytes_total = 0
    per_minute: dict[str, int] = {}
    for g in groups:
        if not isinstance(g, dict):
            continue
        count = int(g.get("count", 0) or 0)
        dims = g.get("dimensions") or {}
        cache_state = (dims.get("cacheStatus") or "").lower()
        minute = dims.get("datetimeMinute")
        bw = (g.get("sum") or {}).get("edgeResponseBytes", 0) or 0
        requests_total += count
        bytes_total += int(bw)
        if cache_state in CACHED_STATES:
            cached_total += count
        if minute:
            per_minute[minute] = per_minute.get(minute, 0) + count

    series = [
        {"since": ts, "all": v, "cached": 0}
        for ts, v in sorted(per_minute.items())
    ]
    cache_hit_pct = (
        round(cached_total / requests_total * 100, 1) if requests_total > 0 else None
    )
    return {
        "reachable": True,
        "error": None,
        "minutes": window_min,
        "requests_total": requests_total,
        "requests_per_min": round(requests_total / max(1, window_min), 1),
        "cache_hit_pct": cache_hit_pct,
        "threats_total": 0,  # WAF on Free is mostly empty; omit from header
        "bandwidth_b": bytes_total,
        "series": series,
    }


async def fetch_access_sessions(settings: Settings, hours: int = 24, limit: int = 100) -> dict:
    """Pull recent Cloudflare Access login events.

    Uses the audit-log API at ``/accounts/{id}/access/logs/access_requests``.
    The CF token needs the "Access: Apps and Policies: Read" permission
    (or equivalent audit-log scope) — without it the call returns 403 and
    we surface ``reachable=false`` with the error so the UI can explain.

    Returns ``{reachable, error, last_login_iso, sessions_24h, items: [...]}``.
    Each item has ``email``, ``app_uid``, ``allowed``, ``created_at``,
    ``ip``, ``country``. Window-bounded server-side; we accept up to 100
    items so a busy account doesn't blow up the cache.
    """
    if not (settings.cf_api_token and settings.cf_account_id):
        return {
            "reachable": False,
            "error": "CF_API_TOKEN oder CF_ACCOUNT_ID nicht konfiguriert",
            "last_login_iso": None,
            "sessions_24h": 0,
            "items": [],
        }
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    since_iso = since.isoformat().replace("+00:00", "Z")
    path = (
        f"/accounts/{settings.cf_account_id}/access/logs/access_requests"
        f"?since={since_iso}&limit={limit}"
    )
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            body = await _get_raw(client, settings, path)
        except httpx.HTTPError as e:
            log.info(
                "cloudflare.access_sessions_failed",
                account=settings.cf_account_id,
                error=str(e),
                error_type=type(e).__name__,
            )
            return {
                "reachable": False,
                "error": f"Access-Audit-Log nicht abrufbar — Token-Scope prüfen ({type(e).__name__})",
                "last_login_iso": None,
                "sessions_24h": 0,
                "items": [],
            }
    raw = body.get("result")
    items: list[dict] = []
    if isinstance(raw, list):
        for r in raw[:limit]:
            if not isinstance(r, dict):
                continue
            items.append(
                {
                    "email": r.get("user_email"),
                    "app_uid": r.get("app_uid"),
                    "allowed": bool(r.get("allowed", True)),
                    "created_at": r.get("created_at"),
                    "ip": r.get("ip_address"),
                    "country": r.get("country"),
                }
            )
    last = items[0]["created_at"] if items else None
    return {
        "reachable": True,
        "error": None,
        "last_login_iso": last,
        "sessions_24h": len(items),
        "items": items,
    }


async def fetch_dns_consistency(settings: Settings) -> list[DNSRecordCheck]:
    """Pull *every* DNS record from the configured zone — no expected-list
    filter, no synthetic 'missing' entries.

    The ``ok`` flag still reflects a tunnel-consistency check for CNAMEs
    pointing at ``cfargotunnel.com`` (must point at our configured tunnel
    id when we have one), but everything else (A, AAAA, MX, TXT, …) just
    reports ok=True so the UI can render the row neutrally."""
    if not (settings.cf_api_token and settings.cf_zone_id):
        return []
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            records = await _get_paginated(
                client, settings, f"/zones/{settings.cf_zone_id}/dns_records"
            )
        except httpx.HTTPError as e:
            log.warning("cloudflare.dns_failed", zone=settings.cf_zone_id, error=str(e))
            return []
    expected_tunnel = (
        f"{settings.cf_tunnel_id}.cfargotunnel.com"
        if settings.cf_tunnel_id else ""
    )
    out: list[DNSRecordCheck] = []
    for rec in records:
        name = rec.get("name", "")
        rtype = rec.get("type", "?")
        content = str(rec.get("content", ""))
        if rtype == "CNAME" and content.endswith("cfargotunnel.com"):
            # Tunnel CNAME — must hit our tunnel id (mis-pointed CNAMEs
            # silently break the dashboard, so this is the one consistency
            # check worth surfacing).
            ok = not expected_tunnel or content == expected_tunnel
        else:
            ok = True
        out.append(
            DNSRecordCheck(
                name=name, type=rtype, content=content,
                expected=expected_tunnel, ok=ok,
            )
        )
    # Stable order: tunnel-CNAMEs first (by zone alpha), then everything else.
    out.sort(key=lambda r: (
        0 if r.content.endswith("cfargotunnel.com") else 1,
        r.name,
    ))
    return out
