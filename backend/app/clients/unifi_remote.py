"""UniFi Site Manager API client (api.ui.com).

The local Integration API (``clients/unifi.py``) covers per-device CPU/RAM
and client lists but does **not** expose ISP metrics or live WAN throughput.
Site Manager — the cloud companion API at ``api.ui.com`` — fills that gap
with the Internet Status Monitor (ISM): latency, jitter, packet loss,
download / upload speeds, and the ISP name as resolved by the controller.

API summary (developer.ui.com/site-manager-api):

    Base:    https://api.ui.com/ea
    Header:  X-API-KEY: <key>

    GET /hosts                          — list of consoles you can see
    GET /sites                          — sites under a host
    GET /isp-metrics/{5m|1h|24h}        — ISM samples for a site

All calls are best-effort. If the key is missing, an endpoint changes shape,
or the controller hasn't accumulated ISM samples yet, this module returns
``None`` and the caller falls back to GeoIP for the ISP name.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog

from ..config import Settings

log = structlog.get_logger("unifi_remote")

API_BASE = "https://api.ui.com/ea"


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
        return [body]
    return []


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _pick(src: dict, *keys: str) -> Any:
    for k in keys:
        if k in src and src[k] is not None:
            return src[k]
    return None


def _extract_metric_sample(latest: dict) -> dict[str, Any]:
    """Field naming drifted across Site Manager API revisions.

    Try the documented aliases first, fall back to generic names so this
    keeps working when UI flips ``wanLatencyAvgMs`` → ``avgLatency`` etc.
    """
    metrics = latest.get("metrics") if isinstance(latest.get("metrics"), dict) else latest
    if not isinstance(metrics, dict):
        return {}
    wan = metrics.get("wan") if isinstance(metrics.get("wan"), dict) else metrics
    return {
        "isp_name": _pick(metrics, "isp", "ispName", "ispProviderName")
        or _pick(wan, "isp", "ispName"),
        "public_ip": _pick(metrics, "wanIp", "publicIp")
        or _pick(wan, "wanIp", "ip"),
        "latency_ms": _num(
            _pick(wan, "avgLatency", "latencyAvg", "wanLatencyAvgMs", "latency")
        ),
        "jitter_ms": _num(
            _pick(wan, "avgJitter", "jitterAvg", "wanJitterAvgMs", "jitter")
        ),
        "packet_loss_pct": _num(
            _pick(wan, "avgPacketLoss", "packetLoss", "wanPacketLoss")
        ),
        "download_mbit": _num(
            _pick(wan, "download", "downloadSpeed", "downloadKbps", "downloadMbps")
        ),
        "upload_mbit": _num(
            _pick(wan, "upload", "uploadSpeed", "uploadKbps", "uploadMbps")
        ),
    }


def _normalise_speed(metric: dict[str, Any]) -> None:
    """Site Manager occasionally returns Kbps for download/upload. Normalise
    to Mbit/s in place when the values look suspiciously large."""
    for key in ("download_mbit", "upload_mbit"):
        v = metric.get(key)
        if v is None:
            continue
        # ISM caps single-link readings at a few Gbps; anything > 10_000 is
        # almost certainly Kbps reported with the wrong suffix.
        if v > 10_000:
            metric[key] = round(v / 1000, 2)


async def fetch_isp_metrics(settings: Settings) -> dict[str, Any] | None:
    """Return the latest ISM sample, or None if unavailable / unconfigured.

    Shape on success::

        {
            "isp_name":        "Vodafone",
            "public_ip":       "1.2.3.4",
            "latency_ms":      12.4,
            "jitter_ms":       1.7,
            "packet_loss_pct": 0.0,
            "download_mbit":   942.3,
            "upload_mbit":     48.1,
            "host_name":       "rxf-ucg",   # for the badge label
        }
    """
    if not settings.unifi_site_manager_api_key:
        return None

    async with httpx.AsyncClient(timeout=8.0) as client:
        hosts_body = await _get(client, settings, "/hosts")
        hosts = _data(hosts_body)
        if not hosts:
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
        host_name = host.get("reportedState", {}).get("name") if isinstance(host.get("reportedState"), dict) else host.get("name")

        sites_body = await _get(client, settings, "/sites", params={"hostId": host_id} if host_id else None)
        sites = _data(sites_body)
        site = next((s for s in sites if isinstance(s, dict)), None)
        if site is None:
            log.info("unifi_remote.no_sites", host_id=host_id)
            return None
        site_id = site.get("siteId") or site.get("id")
        if not site_id:
            return None

        # 5-minute buckets keep the latest sample close to "now".
        ism_body = await _get(
            client, settings, "/isp-metrics/5m", params={"siteId": site_id}
        )
        ism = _data(ism_body)
        if not ism:
            log.info("unifi_remote.no_ism_samples", site_id=site_id)
            return None
        latest = ism[-1] if isinstance(ism, list) else ism
        if not isinstance(latest, dict):
            return None
        metric = _extract_metric_sample(latest)
        _normalise_speed(metric)
        metric["host_name"] = host_name
        log.info(
            "unifi_remote.isp_metrics_ok",
            host_id=host_id,
            site_id=site_id,
            isp=metric.get("isp_name"),
            down=metric.get("download_mbit"),
            up=metric.get("upload_mbit"),
        )
        return metric
