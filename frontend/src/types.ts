export type Status = 'ok' | 'warn' | 'err' | 'idle';

export interface HostStatus {
  node: string;
  pve_version: string | null;
  kernel: string | null;
  uptime_s: number;
  cpu_pct: number;
  cpu_cores: number;
  ram_used_b: number;
  ram_total_b: number;
  disk_used_b: number;
  disk_total_b: number;
  online: boolean;
}

export interface Guest {
  id: number;
  name: string;
  type: 'LXC' | 'VM' | 'HOST';
  status: Status;
  running: boolean;
  ip: string | null;
  service: string | null;
  cpu_pct: number;
  ram_used_b: number;
  ram_total_b: number;
  uptime_s: number;
}

export interface Datastore {
  name: string;
  used_b: number;
  total_b: number;
  used_pct: number;
}

export interface SystemSnapshot {
  host: HostStatus;
  guests: Guest[];
  datastores: Datastore[];
  fetched_at: number;
}

export interface ServiceStatus {
  id: string;
  name: string;
  sub: string;
  icon: string;
  desc: string;
  status: Status;
  ms: number;
  ext: boolean;
  internal: boolean;
  code_ext: number | null;
  code_int: number | null;
  note: string | null;
}

export interface TunnelStatus {
  id: string | null;
  name: string | null;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  connections: number;
  regions: string[];
  cloudflared_version: string | null;
  wan_ip: string | null;
}

export interface BackupSnapshot {
  id: string;
  target: string;
  status: Status;
  verify: 'ok' | 'pending' | 'failed' | '—';
  size_b: number;
  when_iso: string;
  note: string | null;
}

export interface BackupSummary {
  jobs: BackupSnapshot[];
  datastore: Datastore | null;
  last_success_iso: string | null;
  success_today: number;
  total_today: number;
  reachable: boolean;
  error: string | null;
}

export interface NetworkSegment {
  name: string;
  vlan: number | null;
  clients: number;
}

export interface NetworkSnapshot {
  wan_ip: string | null;
  isp: string | null;
  link_down_mbit: number | null;
  link_up_mbit: number | null;
  throughput_down_mbit: number;
  throughput_up_mbit: number;
  networks: NetworkSegment[];
  clients_total: number;
}

export interface CertInfo {
  domain: string;
  issuer: string;
  days_left: number;
}

export interface DNSRecordCheck {
  name: string;
  type: string;
  content: string;
  expected: string;
  ok: boolean;
}

export interface CertsSnapshot {
  certs: CertInfo[];
  dns: DNSRecordCheck[];
}

export interface Identity {
  email: string | null;
  sub: string | null;
  aud: string | null;
}

export interface GuestTask {
  upid: string | null;
  type: string | null;
  user: string | null;
  status: string;
  starttime: number;
  endtime: number | null;
}
