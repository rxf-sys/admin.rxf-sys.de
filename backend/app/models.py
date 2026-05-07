from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Status = Literal["ok", "warn", "err", "idle"]


# ---------- System / Proxmox ----------
class HostStatus(BaseModel):
    node: str
    pve_version: str | None = None
    kernel: str | None = None
    uptime_s: int = 0
    cpu_pct: float = 0.0
    cpu_cores: int = 0
    ram_used_b: int = 0
    ram_total_b: int = 0
    disk_used_b: int = 0
    disk_total_b: int = 0
    online: bool = True


class Guest(BaseModel):
    id: int
    name: str
    type: Literal["LXC", "VM", "HOST"] = "LXC"
    status: Status = "idle"
    running: bool = False
    ip: str | None = None
    service: str | None = None
    cpu_pct: float = 0.0
    ram_used_b: int = 0
    ram_total_b: int = 0
    uptime_s: int = 0


class Datastore(BaseModel):
    name: str
    used_b: int
    total_b: int
    used_pct: float


class SystemSnapshot(BaseModel):
    host: HostStatus
    guests: list[Guest]
    datastores: list[Datastore]
    fetched_at: float


# ---------- Services / Probes ----------
class ServiceStatus(BaseModel):
    id: str
    name: str
    sub: str
    icon: str
    desc: str
    status: Status
    ms: int = 0
    ext: bool = False
    internal: bool = False
    code_ext: int | None = None
    code_int: int | None = None
    note: str | None = None


# ---------- Cloudflare Tunnel ----------
class TunnelStatus(BaseModel):
    id: str | None = None
    name: str | None = None
    status: Literal["healthy", "degraded", "down", "unknown"] = "unknown"
    connections: int = 0
    regions: list[str] = Field(default_factory=list)
    cloudflared_version: str | None = None
    wan_ip: str | None = None


# ---------- Backups ----------
class BackupSnapshot(BaseModel):
    id: str
    target: str
    status: Status
    verify: Literal["ok", "pending", "failed", "—"] = "—"
    size_b: int = 0
    when_iso: str
    note: str | None = None


class BackupSummary(BaseModel):
    jobs: list[BackupSnapshot]
    datastore: Datastore | None = None
    last_success_iso: str | None = None
    success_today: int = 0
    total_today: int = 0
    reachable: bool = True
    error: str | None = None


# ---------- Network / UniFi ----------
class NetworkSegment(BaseModel):
    name: str
    vlan: int | None = None
    clients: int = 0


class NetworkSnapshot(BaseModel):
    wan_ip: str | None = None
    isp: str | None = None
    link_down_mbit: float | None = None
    link_up_mbit: float | None = None
    throughput_down_mbit: float = 0.0
    throughput_up_mbit: float = 0.0
    networks: list[NetworkSegment] = Field(default_factory=list)
    clients_total: int = 0


# ---------- Certs / DNS ----------
class CertInfo(BaseModel):
    domain: str
    issuer: str
    days_left: int


class DNSRecordCheck(BaseModel):
    name: str
    type: str
    content: str
    expected: str
    ok: bool


class CertsSnapshot(BaseModel):
    certs: list[CertInfo]
    dns: list[DNSRecordCheck]
