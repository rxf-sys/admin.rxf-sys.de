export type Status = 'ok' | 'warn' | 'err' | 'idle';

export interface DiskHealth {
  device: string;
  model: string | null;
  size_b: number;
  health: 'PASSED' | 'FAILED' | 'UNKNOWN';
  used_pct: number | null;
  temp_c: number | null;
  type: string | null;
}

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
  cpu_temp_c: number | null;
  disks: DiskHealth[];
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
  /** True for admin-created services (registry), false for the built-in catalogue. */
  custom: boolean;
  /** False when no external endpoint is configured — the UI then hides the EXT pill. */
  ext_monitored: boolean;
  internal_url: string;
  ext_url: string | null;
  /** 30-day rolling, percent. ``null`` when storage is disabled / no samples. */
  uptime_pct: number | null;
  /** 95th percentile response time over the last 24h, ms. */
  p95_ms: number | null;
  /** ISO 8601 timestamp of the most recent incident transition. */
  last_incident_iso: string | null;
}

/** Payload for creating / editing a custom service. */
export interface ServiceInput {
  name: string;
  internal_url: string;
  icon: string;
  desc: string;
  ext_url: string | null;
}

export interface TunnelStatus {
  id: string | null;
  name: string | null;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  connections: number;
  regions: string[];
  cloudflared_version: string | null;
  wan_ip: string | null;
  reachable: boolean;
  error: string | null;
}

export interface BackupSnapshot {
  id: string;
  target: string;
  backup_type: string;
  backup_id: string;
  backup_time: number;
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

export interface UnifiDevice {
  id: string;
  name: string;
  model: string | null;
  ip: string | null;
  state: string;
  firmware: string | null;
  is_gateway: boolean;
  clients: number;
  cpu_pct: number | null;
  mem_pct: number | null;
  uptime_s: number;
  ports_used: number | null;
  ports_total: number | null;
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
  clients_wired: number;
  clients_wireless: number;
  devices: UnifiDevice[];
  reachable: boolean;
  error: string | null;
  auth_mode: 'api-key' | 'cookie' | 'none';
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
  reachable: boolean;
  error: string | null;
}

export type Role = 'admin' | 'user';

export interface Account {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  disabled: boolean;
  created_at: number;
  last_login_at: number | null;
}

/** Shape returned by GET /api/me — the lightweight identity probe. */
export interface Identity {
  id: number;
  username: string;
  email: string | null;
  role: Role;
}

export interface GuestTask {
  upid: string | null;
  type: string | null;
  user: string | null;
  status: string;
  starttime: number;
  endtime: number | null;
}

export interface ProbeSample {
  ts: number;
  status: 'ok' | 'warn' | 'err' | 'idle';
  ms: number;
}

export interface ServiceHistory {
  service_id: string;
  hours: number;
  enabled: boolean;
  uptime_pct: number | null;
  p95_ms: number | null;
  last_incident_iso: string | null;
  samples: ProbeSample[];
}

export interface GuestMetricSample {
  ts: number;
  cpu_pct: number;
  ram_used_b: number;
  ram_total_b: number;
}

export interface GuestHistory {
  vmid: number;
  hours: number;
  enabled: boolean;
  samples: GuestMetricSample[];
}

export interface GuestBackups {
  vmid: number;
  limit: number;
  reachable: boolean;
  error: string | null;
  jobs: BackupSnapshot[];
}

export interface NetworkThroughputSample {
  ts: number;
  down_mbit: number;
  up_mbit: number;
}

export interface NetworkThroughput {
  hours: number;
  enabled: boolean;
  peak_down_mbit: number;
  peak_up_mbit: number;
  samples: NetworkThroughputSample[];
}

export interface BackupHeatmapCell {
  day: string;
  label: 'empty' | 'ok' | 'partial' | 'err';
  ok: number;
  warn: number;
  err: number;
  total: number;
  bytes_total: number;
}

export interface BackupHeatmap {
  days: number;
  reachable: boolean;
  error: string | null;
  success_pct: number | null;
  cells: BackupHeatmapCell[];
}

export interface BackupStorageItem {
  target: string;
  backup_type: string;
  backup_id: string;
  size_b: number;
  count: number;
}

export interface BackupStorage {
  reachable: boolean;
  error: string | null;
  total_b: number;
  items: BackupStorageItem[];
}

export interface AccessSession {
  email: string | null;
  app_uid: string | null;
  allowed: boolean;
  created_at: string | null;
  ip: string | null;
  country: string | null;
}

export interface AccessSessions {
  reachable: boolean;
  error: string | null;
  last_login_iso: string | null;
  sessions_24h: number;
  items: AccessSession[];
}

export interface AuditFinding {
  id: string;
  status: 'ok' | 'warn' | 'err' | 'skipped';
  title: string;
  detail: string;
  /** Optional category for grouping in the UI. When absent the frontend
   * derives one from the leading dot-segment of ``id`` (e.g. ``updates`` from
   * ``updates.security_pending``). */
  category?: string;
  /** Optional remediation snippet — typically a shell command — shown inline
   * under the finding when present. */
  fix?: string;
}

export interface AuditSummary {
  ok: number;
  warn: number;
  err: number;
  skipped: number;
}

export interface AuditRun {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'warn' | 'err' | 'timeout';
  exit_code: number | null;
  started_by: string | null;
  location: string;
  summary: AuditSummary | null;
  findings: AuditFinding[];
  error: string | null;
  /** Present only on the per-job endpoint. */
  log_output?: string;
}

export interface AuditJobsList {
  current_job_id: string | null;
  jobs: AuditRun[];
}
