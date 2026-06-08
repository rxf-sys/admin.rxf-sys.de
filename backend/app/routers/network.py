from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import storage
from ..auth import verify_session
from ..cache import cache
from ..clients import geoip, unifi, unifi_remote
from ..config import Settings, get_settings
from ..models import IspMetrics, NetworkSnapshot

router = APIRouter(prefix="/api/network", tags=["network"], dependencies=[Depends(verify_session)])


@router.get("", response_model=NetworkSnapshot)
async def get_network(settings: Settings = Depends(get_settings)) -> NetworkSnapshot:
    async def loader() -> NetworkSnapshot:
        snap = await unifi.fetch_network_snapshot(settings)

        # Site Manager API (cloud) — augments the local snapshot with ISP
        # name + live throughput / latency / packet loss when the operator
        # has configured a key.
        update: dict = {}
        if settings.unifi_site_manager_api_key:
            sm_loader = lambda: unifi_remote.fetch_isp_metrics(settings)  # noqa: E731
            metrics_raw = await cache.get_or_set(
                "network.site_manager", settings.cache_ttl_unifi, sm_loader
            )
            if metrics_raw:
                metrics = IspMetrics(**metrics_raw)
                update["isp_metrics"] = metrics
                if metrics.isp_name and not snap.isp:
                    update["isp"] = metrics.isp_name
                # Use the ISM speed sample as a live readout if the local
                # snapshot doesn't have its own throughput numbers (the
                # Integration API only reports zeros).
                if metrics.download_mbit is not None and snap.throughput_down_mbit == 0:
                    update["throughput_down_mbit"] = metrics.download_mbit
                if metrics.upload_mbit is not None and snap.throughput_up_mbit == 0:
                    update["throughput_up_mbit"] = metrics.upload_mbit

        # GeoIP fallback for ISP name — only when Site Manager didn't supply one.
        isp_after_sm = update.get("isp") or snap.isp
        if snap.reachable and snap.wan_ip and not isp_after_sm:
            ip = snap.wan_ip

            async def isp_loader() -> str | None:
                return await geoip.fetch_isp(settings, ip)

            isp = await cache.get_or_set(f"geoip:{ip}", settings.cache_ttl_geoip, isp_loader)
            if isp:
                update["isp"] = isp

        if update:
            snap = snap.model_copy(update=update)
        return snap

    return await cache.get_or_set("network", settings.cache_ttl_unifi, loader)


@router.get("/throughput")
async def get_throughput(hours: int = 1) -> dict:
    """WAN up/down time series, fed by the background metrics sampling loop.

    Returns ``enabled=false`` when storage is disabled and an empty samples
    list when the loop hasn't accumulated points yet. ``hours`` is capped at
    24 to keep the response small.
    """
    hours = max(1, min(hours, 24))
    samples = await storage.network_history(hours=hours)
    peak_down = max((s["down_mbit"] for s in samples), default=0.0)
    peak_up = max((s["up_mbit"] for s in samples), default=0.0)
    return {
        "hours": hours,
        "enabled": storage.is_enabled(),
        "peak_down_mbit": round(peak_down, 2),
        "peak_up_mbit": round(peak_up, 2),
        "samples": samples,
    }
