"""UniFi Site Manager API client (api.ui.com).

The local Integration API (``clients/unifi.py``) covers per-device CPU/RAM
and client lists but does not expose ISP metrics or live WAN throughput.
Site Manager — the cloud companion API at ``api.ui.com`` — fills that gap
with the Internet Status Monitor (ISM): latency, jitter, packet loss,
download / upload speeds, and the ISP name as resolved by the controller.

API summary (developer.ui.com/site-manager-api):

    Base:    https://api.ui.com/v1
    Header:  X-API-KEY: <key>

    GET /hosts                          — list of consoles you can see
    GET /sites                          — sites under a host
    GET /devices                        — devices per host (CPU/MEM enrichment)
    GET /isp-metrics/{5m|1h|24h}        — ISM samples per site

ISP-metrics response shape (verified against developer.ui.com docs)::

    { "data": [ {
        "metricType": "5m",
        "siteId":     "...",
        "hostId":     "...",
        "periods": [
          { "metricTime": "2026-06-08T11:00:00Z",
            "version":    "1",
            "data": { "wan": {
                "avgLatency":    1,
                "maxLatency":    2,
                "packetLoss":    0,
                "uptime":        100,
                "downtime":      0,
                "download_kbps": 942000,
                "upload_kbps":   48000,
                "ispName":       "Vodafone",
                "ispAsn":        "12578"
            } } }
        ] } ] }

We always read the **last** period's ``data.wan`` block — that's "right
now" for the 5-minute series.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog

from ..config import Settings

log = structlog.get_logger("unifi_remote")

API_BASE = "https://api.ui.com/v1"


def _headers(settings: Settings) -> dict[str, str]:
    return {
        "X-API-KEY": settings.unifi_site_manager_api_key,
        "Accept": "application/json",
    }


async def _get(
    client: httpx.AsyncClient,
    settings: Settings,
    path: str,
    *,
    params: dict[str, Any] | None = None,
) -> dict | list | None:
    url = f"{API_BASE}{path}"
    try:
        r = await client.get(url, headers=_headers(settings), params=params)
    except httpx.HTTPError as e:
        log.info("unifi_remote.request_error", path=path, error=str(e))
        return None
    if r.status_code != 200:
        log.info(
            "unifi_remote.status_not_ok",
            path=path,
            status=r.status_code,
            body=r.text[:200],
        )
        return None
    try:
        return r.json()
    except ValueError:
        log.info("unifi_remote.non_json", path=path)
        return None


def _data(body: dict | list | None) -> list:
    """Normalise ``{"data": [...]}`` / bare-list / bare-object responses."""
    if body is None:
        return []
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        d = body.get("data")
        if isinstance(d, list):
            return d
        if isinstance(d, dict):
            return [d]
        return [body]
    return []


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    # Treat sentinel -1 (which some UI firmware uses for "no sample") as missing.
    return f if f >= 0 else None


def _pick(src: dict, *keys: str) -> Any:
    for k in keys:
        if k in src and src[k] is not None:
            return src[k]
    return None


def _host_label(host: dict) -> str | None:
    """Best-effort friendly name for a host.

    The Site Manager hosts response nests the friendly name in several
    places depending on UniFi OS / Network version, so probe a few in
    order. Falls back to the raw id only if nothing else exists.
    """
    reported = host.get("reportedState") if isinstance(host.get("reportedState"), dict) else {}
    user = host.get("userData") if isinstance(host.get("userData"), dict) else {}
    hw = reported.get("hardware") if isinstance(reported.get("hardware"), dict) else {}
    return (
        user.get("alias")
        or reported.get("hostname")
        or reported.get("name")
        or hw.get("shortname")
        or hw.get("name")
        or host.get("name")
    )


def _extract_wan(period: dict) -> dict[str, Any]:
    """Pull the wan-stats sub-object out of one period.

    Real shape::

        { "metricTime": "...", "data": { "wan": { ... } } }

    Falls back to ``period["wan"]`` if the controller emits a flatter
    layout (observed on some pre-release firmware revisions).
    """
    if not isinstance(period, dict):
        return {}
    data = period.get("data") if isinstance(period.get("data"), dict) else None
    if data is None:
        return period.get("wan") if isinstance(period.get("wan"), dict) else {}
    wan = data.get("wan")
    return wan if isinstance(wan, dict) else data


def _wan_to_metric(wan: dict) -> dict[str, Any]:
    """Translate one wan-stats block into our normalised metric shape."""
    download_kbps = _num(_pick(wan, "download_kbps", "downloadKbps", "downloadKbits"))
    upload_kbps = _num(_pick(wan, "upload_kbps", "uploadKbps", "uploadKbits"))
    # Some firmware emits megabit values directly. Probe Mbps fields first.
    download_mbps = _num(_pick(wan, "downloadMbps", "download", "downloadSpeed"))
    upload_mbps = _num(_pick(wan, "uploadMbps", "upload", "uploadSpeed"))

    def to_mbit(kbps: float | None, mbps: float | None) -> float | None:
        if kbps is not None:
            return round(kbps / 1000.0, 2)
        if mbps is None:
            return None
        # If the controller reports impossibly large "Mbps" values, it's
        # actually kbps mis-labelled — flip to Mbit.
        return round(mbps / 1000.0, 2) if mbps > 10_000 else round(mbps, 2)

    return {
        "isp_name": _pick(wan, "ispName", "isp", "ispProviderName"),
        "isp_asn": _pick(wan, "ispAsn", "ispASN"),
        "public_ip": _pick(wan, "wanIp", "publicIp", "ip"),
        "latency_ms": _num(_pick(wan, "avgLatency", "latencyAvg", "latency", "wanLatencyAvgMs")),
        "jitter_ms": _num(_pick(wan, "avgJitter", "jitterAvg", "jitter", "wanJitterAvgMs")),
        "packet_loss_pct": _num(_pick(wan, "packetLoss", "avgPacketLoss", "wanPacketLoss")),
        "download_mbit": to_mbit(download_kbps, download_mbps),
        "upload_mbit": to_mbit(upload_kbps, upload_mbps),
        "uptime_pct": _num(_pick(wan, "uptime")),
    }


def _latest_metric(ism_entries: list) -> dict[str, Any] | None:
    """Walk the ISM response and return the most recent wan sample.

    The outer list is per-site (we always have one). Inside ``periods`` is
    a chronological list — last entry is "now". Pick the latest period
    that actually has a wan block; older firmware sometimes drops empty
    sample frames into the array.
    """
    for entry in ism_entries:
        if not isinstance(entry, dict):
            continue
        periods = entry.get("periods")
        if not isinstance(periods, list) or not periods:
            continue
        for period in reversed(periods):
            wan = _extract_wan(period)
            if wan:
                metric = _wan_to_metric(wan)
                # Keep at least one truthy numeric/string before declaring it
                # a real sample — otherwise empty sentinel frames slip through.
                if any(v not in (None, "") for v in metric.values()):
                    return metric
    return None


async def fetch_isp_metrics(settings: Settings) -> dict[str, Any] | None:
    """Return the latest ISM sample, or None if unavailable / unconfigured."""
    if not settings.unifi_site_manager_api_key:
        return None

    async with httpx.AsyncClient(timeout=8.0) as client:
        hosts_body = await _get(client, settings, "/hosts")
        hosts = _data(hosts_body)
        if not hosts:
            log.info("unifi_remote.no_hosts")
            return None
        target = settings.unifi_site_manager_host_id
        host = (
            next((h for h in hosts if isinstance(h, dict) and h.get("id") == target), None)
            if target
            else None
        )
        if host is None:
            host = next((h for h in hosts if isinstance(h, dict)), None)
        if host is None:
            return None
        host_id = host.get("id")
        host_name = _host_label(host)

        # /sites accepts hostId as a query param; not all firmware honours it,
        # so we also filter client-side as a fallback.
        sites_body = await _get(
            client, settings, "/sites", params={"hostId": host_id} if host_id else None
        )
        all_sites = _data(sites_body)
        sites = [
            s for s in all_sites
            if isinstance(s, dict) and (not host_id or s.get("hostId") in (None, host_id))
        ]
        site = next((s for s in sites if isinstance(s, dict)), None)
        if site is None:
            log.info("unifi_remote.no_sites", host_id=host_id, raw_count=len(all_sites))
            return None
        site_id = site.get("siteId") or site.get("id")
        if not site_id:
            log.info("unifi_remote.site_missing_id", site_keys=list(site.keys()))
            return None

        ism_body = await _get(
            client, settings, "/isp-metrics/5m", params={"siteId": site_id}
        )
        ism_entries = _data(ism_body)
        if not ism_entries:
            log.info("unifi_remote.no_ism_samples", site_id=site_id)
            return None

        metric = _latest_metric(ism_entries)
        if metric is None:
            # First sample after a controller restart can be empty — log the
            # shape we saw so the operator can debug without us guessing.
            first = ism_entries[0] if isinstance(ism_entries[0], dict) else {}
            log.info(
                "unifi_remote.ism_empty",
                site_id=site_id,
                top_keys=list(first.keys()),
                period_count=len(first.get("periods") or []),
            )
            return None

        metric["host_name"] = host_name
        log.info(
            "unifi_remote.isp_metrics_ok",
            host_id=host_id,
            site_id=site_id,
            isp=metric.get("isp_name"),
            latency=metric.get("latency_ms"),
            down=metric.get("download_mbit"),
            up=metric.get("upload_mbit"),
        )
        return metric
