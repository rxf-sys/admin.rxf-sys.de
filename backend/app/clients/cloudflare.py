from __future__ import annotations

from datetime import datetime, timezone

import httpx

from ..config import Settings
from ..models import CertInfo, DNSRecordCheck, TunnelStatus

CF_API = "https://api.cloudflare.com/client/v4"

# Subdomains expected to CNAME to <tunnel_id>.cfargotunnel.com.
EXPECTED_TUNNEL_SUBS = ["vault", "cloud", "photos", "docs", "media", "ha", "monitor", "pbs"]


def _auth(settings: Settings) -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.cf_api_token}"}


async def _get(client: httpx.AsyncClient, settings: Settings, path: str) -> dict | list:
    r = await client.get(f"{CF_API}{path}", headers=_auth(settings))
    r.raise_for_status()
    body = r.json()
    if not body.get("success", False):
        raise httpx.HTTPError(f"CF API error: {body.get('errors')}")
    return body.get("result", {})


async def fetch_tunnel_status(settings: Settings) -> TunnelStatus:
    if not (settings.cf_api_token and settings.cf_account_id and settings.cf_tunnel_id):
        return TunnelStatus()
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
        except httpx.HTTPError:
            return TunnelStatus(id=settings.cf_tunnel_id, status="unknown")

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


async def fetch_certs(settings: Settings) -> list[CertInfo]:
    if not (settings.cf_api_token and settings.cf_zone_id):
        return []
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            packs = await _get(client, settings, f"/zones/{settings.cf_zone_id}/ssl/certificate_packs")
        except httpx.HTTPError:
            return []
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
                hosts = cert.get("hosts") or [p.get("hosts", [None])[0] or "?"]
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
    return sorted(dedup.values(), key=lambda c: c.days_left)


async def fetch_dns_consistency(settings: Settings) -> list[DNSRecordCheck]:
    if not (settings.cf_api_token and settings.cf_zone_id and settings.cf_tunnel_id):
        return []
    expected = f"{settings.cf_tunnel_id}.cfargotunnel.com"
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            records = await _get(
                client, settings, f"/zones/{settings.cf_zone_id}/dns_records?per_page=200"
            )
        except httpx.HTTPError:
            return []
    by_name: dict[str, dict] = {}
    if isinstance(records, list):
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
