from __future__ import annotations

import httpx

from ..config import Settings
from ..models import Datastore, Guest, HostStatus

# Map known CT/VM IDs -> service label (matches the table the user supplied).
GUEST_SERVICE_LABELS: dict[int, str] = {
    100: "Samba (NAS)",
    101: "NPM (deprecated)",
    102: "Vaultwarden",
    103: "Uptime Kuma",
    104: "Portainer + Immich + cloudflared",
    105: "Nextcloud AIO",
    106: "Jellyfin",
    200: "Home Assistant",
    201: "Proxmox Backup Server",
}


def _auth_header(settings: Settings) -> dict[str, str]:
    return {
        "Authorization": f"PVEAPIToken={settings.proxmox_token_id}={settings.proxmox_token_secret}",
    }


def _base_url(settings: Settings) -> str:
    return f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"


async def _get(client: httpx.AsyncClient, settings: Settings, path: str) -> dict:
    r = await client.get(f"{_base_url(settings)}{path}", headers=_auth_header(settings))
    r.raise_for_status()
    return r.json().get("data", {})


def _status_from_running(running: bool, cpu: float, ram_pct: float) -> str:
    if not running:
        return "idle"
    if cpu > 0.9 or ram_pct > 0.9:
        return "err"
    if cpu > 0.75 or ram_pct > 0.8:
        return "warn"
    return "ok"


async def fetch_host_status(settings: Settings) -> HostStatus:
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=8.0) as client:
        try:
            status = await _get(client, settings, f"/nodes/{settings.proxmox_node}/status")
            version = await _get(client, settings, "/version")
        except httpx.HTTPError:
            return HostStatus(node=settings.proxmox_node, online=False)

    cpu_pct = float(status.get("cpu", 0.0)) * 100.0
    mem = status.get("memory", {})
    rootfs = status.get("rootfs", {})
    return HostStatus(
        node=settings.proxmox_node,
        pve_version=version.get("version") if isinstance(version, dict) else None,
        kernel=status.get("kversion") or status.get("current-kernel", {}).get("release"),
        uptime_s=int(status.get("uptime", 0)),
        cpu_pct=cpu_pct,
        cpu_cores=int(status.get("cpuinfo", {}).get("cpus", 0)),
        ram_used_b=int(mem.get("used", 0)),
        ram_total_b=int(mem.get("total", 0)),
        disk_used_b=int(rootfs.get("used", 0)),
        disk_total_b=int(rootfs.get("total", 0)),
        online=True,
    )


async def _fetch_guest_ip(client: httpx.AsyncClient, settings: Settings, gtype: str, vmid: int) -> str | None:
    """Pull configured IP from /config (LXC) or guest-agent (VM). Best-effort."""
    try:
        if gtype == "lxc":
            cfg = await _get(client, settings, f"/nodes/{settings.proxmox_node}/lxc/{vmid}/config")
            for k, v in cfg.items():
                if k.startswith("net") and isinstance(v, str) and "ip=" in v:
                    for part in v.split(","):
                        if part.startswith("ip="):
                            ip = part[3:].split("/")[0]
                            if ip and ip != "dhcp":
                                return ip
        else:  # qemu
            try:
                ifaces = await _get(
                    client, settings, f"/nodes/{settings.proxmox_node}/qemu/{vmid}/agent/network-get-interfaces"
                )
                for iface in ifaces.get("result", []):
                    for addr in iface.get("ip-addresses", []):
                        if addr.get("ip-address-type") == "ipv4" and not addr["ip-address"].startswith("127."):
                            return addr["ip-address"]
            except httpx.HTTPError:
                return None
    except httpx.HTTPError:
        return None
    return None


async def fetch_guests(settings: Settings) -> list[Guest]:
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=10.0) as client:
        try:
            lxcs = await _get(client, settings, f"/nodes/{settings.proxmox_node}/lxc")
            qemus = await _get(client, settings, f"/nodes/{settings.proxmox_node}/qemu")
        except httpx.HTTPError:
            return []

        result: list[Guest] = []
        for entry, gtype in [*((g, "lxc") for g in lxcs), *((g, "qemu") for g in qemus)]:
            vmid = int(entry["vmid"])
            running = entry.get("status") == "running"
            cpu = float(entry.get("cpu", 0.0))
            ram_used = int(entry.get("mem", 0))
            ram_total = int(entry.get("maxmem", 0)) or 1
            ram_pct = ram_used / ram_total
            ip = await _fetch_guest_ip(client, settings, gtype, vmid) if running else None
            result.append(
                Guest(
                    id=vmid,
                    name=str(entry.get("name", f"vm-{vmid}")),
                    type="LXC" if gtype == "lxc" else "VM",
                    status=_status_from_running(running, cpu, ram_pct),  # type: ignore[arg-type]
                    running=running,
                    ip=ip,
                    service=GUEST_SERVICE_LABELS.get(vmid),
                    cpu_pct=cpu * 100.0,
                    ram_used_b=ram_used,
                    ram_total_b=ram_total if ram_total > 1 else int(entry.get("maxmem", 0)),
                    uptime_s=int(entry.get("uptime", 0)),
                )
            )
        result.sort(key=lambda g: g.id)
        return result


async def fetch_datastores(settings: Settings) -> list[Datastore]:
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=8.0) as client:
        try:
            stores = await _get(client, settings, f"/nodes/{settings.proxmox_node}/storage")
        except httpx.HTTPError:
            return []
    out: list[Datastore] = []
    for s in stores:
        used = int(s.get("used", 0))
        total = int(s.get("total", 0)) or 1
        out.append(
            Datastore(
                name=str(s.get("storage", "?")),
                used_b=used,
                total_b=total,
                used_pct=round(used / total * 100, 1),
            )
        )
    return out


async def restart_guest(settings: Settings, vmid: int, gtype: str) -> bool:
    path_type = "lxc" if gtype.lower() in ("lxc", "ct") else "qemu"
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=10.0) as client:
        r = await client.post(
            f"{_base_url(settings)}/nodes/{settings.proxmox_node}/{path_type}/{vmid}/status/reboot",
            headers=_auth_header(settings),
        )
        return r.status_code in (200, 202)
