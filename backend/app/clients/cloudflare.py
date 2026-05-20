from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import structlog

from ..config import Settings
from ..models import CertInfo, DNSRecordCheck, TunnelStatus

log = structlog.get_logger("cloudflare")

CF_API = "https://api.cloudflare.com/client/v4"

# Subdomains expected to CNAME to <tunnel_id>.cfargotunnel.com.
EXPECTED_TUNNEL_SUBS = ["vault", "cloud", "photos", "docs", "media", "ha", "monitor", "pbs"]


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
    if not (settings.cf_api_token and settings.cf_zone_id and settings.cf_tunnel_id):
        return []
    expected = f"{settings.cf_tunnel_id}.cfargotunnel.com"
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            records = await _get_paginated(
                client, settings, f"/zones/{settings.cf_zone_id}/dns_records"
            )
        except httpx.HTTPError as e:
            log.warning("cloudflare.dns_failed", zone=settings.cf_zone_id, error=str(e))
            return []
    by_name: dict[str, dict] = {}
    for rec in records:
        name = rec.get("name", "")
        by_name[name] = rec
    out: list[DNSRecordCheck] = []
    for sub in EXPECTED_TUNNEL_SUBS:
        fqdn = f"{sub}.{settings.cf_zone_name}"
        rec = by_name.get(fqdn)
        if rec is None:
            out.append(DNSRecordCheck(name=fqdn, type="—", content="missing", expected=expected, ok=False))
            continue
        content = rec.get("content", "")
        ok = rec.get("type") == "CNAME" and content.endswith("cfargotunnel.com")
        out.append(
            DNSRecordCheck(
                name=fqdn, type=rec.get("type", "?"), content=content, expected=expected, ok=ok
            )
        )
    return out
