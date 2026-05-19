from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import storage
from ..auth import verify_cf_access
from ..cache import cache
from ..clients import geoip, unifi
from ..config import Settings, get_settings
from ..models import NetworkSnapshot

router = APIRouter(prefix="/api/network", tags=["network"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=NetworkSnapshot)
async def get_network(settings: Settings = Depends(get_settings)) -> NetworkSnapshot:
    async def loader() -> NetworkSnapshot:
        snap = await unifi.fetch_network_snapshot(settings)
        # The Integration API doesn't expose the ISP name. Look it up from
        # the public IP via a geolocation provider (cached separately).
        if snap.reachable and snap.wan_ip and not snap.isp:
            ip = snap.wan_ip

            async def isp_loader() -> str | None:
                return await geoip.fetch_isp(settings, ip)

            isp = await cache.get_or_set(f"geoip:{ip}", settings.cache_ttl_geoip, isp_loader)
            if isp:
                snap = snap.model_copy(update={"isp": isp})
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
