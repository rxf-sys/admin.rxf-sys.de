from __future__ import annotations

import httpx
import structlog

from ..config import Settings
from ..models import Datastore, DiskHealth, Guest, HostStatus

log = structlog.get_logger("proxmox")

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


def _extract_cpu_temp(status: dict) -> float | None:
    """Best-effort CPU temperature extraction. Proxmox 8 exposes sensor data
    under several different keys depending on lm-sensors output and host CPU;
    we sniff the common shapes."""
    candidates: list[float] = []

    # Newer PVE may expose top-level "cputemp" (single value)
    direct = status.get("cputemp")
    if isinstance(direct, (int, float)):
        return float(direct)

    sensors = status.get("sensors") or status.get("cpu-temperature")
    if isinstance(sensors, dict):
        for chip, data in sensors.items():
            if not isinstance(data, dict):
                continue
            for key, value in data.items():
                if not isinstance(value, dict):
                    continue
                # lm-sensors keys like "temp1_input"
                t = value.get("temp1_input") or value.get("Tctl") or value.get("Package id 0")
                if isinstance(t, (int, float)):
                    candidates.append(float(t))
                # Or nested per-core readings
                for sub_key, sub_val in value.items():
                    if "input" in sub_key.lower() and isinstance(sub_val, (int, float)):
                        candidates.append(float(sub_val))
            _ = chip  # silence unused
    if candidates:
        return round(max(candidates), 1)
    return None


async def fetch_host_status(settings: Settings) -> HostStatus:
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=8.0) as client:
        try:
            status = await _get(client, settings, f"/nodes/{settings.proxmox_node}/status")
            version = await _get(client, settings, "/version")
        except httpx.HTTPError as e:
            log.warning(
                "proxmox.host_status_failed",
                host=settings.proxmox_host,
                node=settings.proxmox_node,
                error=str(e),
                error_type=type(e).__name__,
            )
            return HostStatus(node=settings.proxmox_node, online=False)

        # Disks are best-effort: requires Sys.Audit and may not be exposed on
        # all storage configs.
        disks: list[DiskHealth] = []
        try:
            raw_disks = await _get(
                client, settings, f"/nodes/{settings.proxmox_node}/disks/list"
            )
            for d in raw_disks if isinstance(raw_disks, list) else []:
                health = (d.get("health") or "UNKNOWN").upper()
                if health not in ("PASSED", "FAILED", "UNKNOWN"):
                    health = "UNKNOWN"
                used = d.get("used", 0)
                size = int(d.get("size", 0) or 0)
                used_pct = None
                if isinstance(used, (int, float)) and size:
                    used_pct = round(float(used) / size * 100, 1) if used else None
                temp = d.get("temperature")
                disks.append(
                    DiskHealth(
                        device=str(d.get("devpath") or d.get("model") or "?"),
                        model=d.get("model"),
                        size_b=size,
                        health=health,  # type: ignore[arg-type]
                        used_pct=used_pct,
                        temp_c=float(temp) if isinstance(temp, (int, float)) else None,
                        type=d.get("type"),
                    )
                )
        except httpx.HTTPError as e:
            log.info("proxmox.disks_unavailable", error=str(e))

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
        cpu_temp_c=_extract_cpu_temp(status),
        disks=disks,
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
        except httpx.HTTPError as e:
            log.warning(
                "proxmox.guests_failed",
                host=settings.proxmox_host,
                node=settings.proxmox_node,
                error=str(e),
                error_type=type(e).__name__,
            )
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
        except httpx.HTTPError as e:
            log.warning("proxmox.datastores_failed", host=settings.proxmox_host, error=str(e))
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


async def fetch_task_log(settings: Settings, upid: str, limit: int = 200) -> list[dict]:
    """Lines for a Proxmox task (UPID)."""
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=8.0) as client:
        try:
            data = await _get(
                client,
                settings,
                f"/nodes/{settings.proxmox_node}/tasks/{upid}/log?limit={limit}",
            )
        except httpx.HTTPError as e:
            log.info("proxmox.task_log_failed", upid=upid, error=str(e))
            return []
    out: list[dict] = []
    for line in data if isinstance(data, list) else []:
        out.append({"n": int(line.get("n", 0)), "t": str(line.get("t", ""))})
    out.sort(key=lambda x: x["n"])
    return out


async def fetch_host_journal_for_vmid(
    settings: Settings, vmid: int, lastentries: int = 500
) -> list[str]:
    """Return host-journal lines that mention this VMID.

    Proxmox does not expose an API to read inside a container — the
    Integration API only offers ``/journal`` for the host. We fetch the last
    N entries and filter for the VMID as a whole word, which catches the
    usual ``lxc-<vmid>``, ``pve-container@<vmid>.service``, and bare-id
    references that systemd / pveproxy / pve-firewall emit around lifecycle
    events. This is *not* a replacement for ``journalctl`` inside the guest,
    but it surfaces host-side events for that container without requiring
    SSH access.
    """
    import re

    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=10.0) as client:
        try:
            data = await _get(
                client,
                settings,
                f"/nodes/{settings.proxmox_node}/journal?lastentries={lastentries}",
            )
        except httpx.HTTPError as e:
            log.warning("proxmox.journal_failed", vmid=vmid, error=str(e))
            return []

    if not isinstance(data, list):
        return []

    # \b<vmid>\b matches the id as a standalone token. We also accept
    # ``lxc-<vmid>`` and ``CT <vmid>`` shapes explicitly so a numeric-prefix
    # in a longer word (e.g. memory addresses) doesn't generate false hits.
    pattern = re.compile(rf"(?:\blxc-{vmid}\b|\bCT\s*{vmid}\b|@{vmid}\.service|\b{vmid}\b)")
    return [line for line in data if isinstance(line, str) and pattern.search(line)]


async def fetch_guest_tasks(settings: Settings, vmid: int, limit: int = 10) -> list[dict]:
    """Recent Proxmox cluster tasks scoped to a single VMID."""
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=8.0) as client:
        try:
            tasks = await _get(
                client,
                settings,
                f"/nodes/{settings.proxmox_node}/tasks?vmid={vmid}&limit={limit}",
            )
        except httpx.HTTPError as e:
            log.warning("proxmox.tasks_failed", vmid=vmid, error=str(e))
            return []
    out: list[dict] = []
    for t in tasks if isinstance(tasks, list) else []:
        out.append(
            {
                "upid": t.get("upid"),
                "type": t.get("type"),
                "user": t.get("user"),
                "status": t.get("status", "running"),
                "starttime": int(t.get("starttime", 0)),
                "endtime": int(t.get("endtime", 0)) or None,
            }
        )
    return out


async def _wait_for_task(
    client: httpx.AsyncClient,
    settings: Settings,
    upid: str,
    *,
    timeout_s: float = 30.0,
    interval_s: float = 1.0,
) -> bool:
    """Poll a Proxmox task UPID until it stops or the timeout elapses.

    Proxmox actions like reboot return immediately with a UPID and execute
    asynchronously. The HTTP 200 only acknowledges that the task was queued.
    We poll ``/tasks/{upid}/status`` and return True iff the task finishes
    with ``exitstatus == "OK"``. A timeout returns False (we don't know).
    """
    import asyncio

    deadline = asyncio.get_event_loop().time() + timeout_s
    path = f"/nodes/{settings.proxmox_node}/tasks/{upid}/status"
    while True:
        try:
            data = await _get(client, settings, path)
        except httpx.HTTPError as e:
            log.info("proxmox.task_status_failed", upid=upid, error=str(e))
            return False
        if isinstance(data, dict) and data.get("status") == "stopped":
            exit_status = (data.get("exitstatus") or "").upper()
            ok = exit_status == "OK"
            if not ok:
                log.info("proxmox.task_failed", upid=upid, exitstatus=exit_status)
            return ok
        if asyncio.get_event_loop().time() >= deadline:
            log.info("proxmox.task_timeout", upid=upid, timeout_s=timeout_s)
            return False
        await asyncio.sleep(interval_s)


async def restart_guest(settings: Settings, vmid: int, gtype: str) -> bool:
    """Trigger reboot and wait for the resulting Proxmox task to finish.

    Returns True only when the task reports ``exitstatus=OK``. A 200/202 on
    the reboot call alone just means the task was queued — for VMs/CTs that
    fail to shut down cleanly the actual reboot can still error out, and we
    want the dashboard's success toast to reflect that.
    """
    path_type = "lxc" if gtype.lower() in ("lxc", "ct") else "qemu"
    async with httpx.AsyncClient(verify=settings.proxmox_verify_tls, timeout=10.0) as client:
        r = await client.post(
            f"{_base_url(settings)}/nodes/{settings.proxmox_node}/{path_type}/{vmid}/status/reboot",
            headers=_auth_header(settings),
        )
        if r.status_code not in (200, 202):
            return False
        # PVE returns the UPID as the `data` field of a plain JSON envelope.
        try:
            upid = r.json().get("data")
        except ValueError:
            upid = None
        if not isinstance(upid, str) or not upid.startswith("UPID:"):
            # No UPID — fall back to the legacy "accepted == success" semantics.
            return True
        return await _wait_for_task(client, settings, upid)
