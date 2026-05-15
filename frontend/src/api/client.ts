import type {
  BackupSummary,
  CertsSnapshot,
  GuestTask,
  Identity,
  NetworkSnapshot,
  ServiceHistory,
  ServiceStatus,
  SystemSnapshot,
  TunnelStatus,
} from '../types';

class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body}`);
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { credentials: 'include', signal });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new ApiError(r.status, text);
  }
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new ApiError(r.status, text);
  }
  return r.json() as Promise<T>;
}

export const api = {
  me: (signal?: AbortSignal) => get<Identity>('/api/me', signal),
  system: (signal?: AbortSignal) => get<SystemSnapshot>('/api/system', signal),
  services: (signal?: AbortSignal) => get<ServiceStatus[]>('/api/services', signal),
  serviceHistory: (id: string, hours = 24, signal?: AbortSignal) =>
    get<ServiceHistory>(`/api/services/${encodeURIComponent(id)}/history?hours=${hours}`, signal),
  tunnel: (signal?: AbortSignal) => get<TunnelStatus>('/api/tunnel', signal),
  backups: (signal?: AbortSignal) => get<BackupSummary>('/api/backups', signal),
  network: (signal?: AbortSignal) => get<NetworkSnapshot>('/api/network', signal),
  certs: (signal?: AbortSignal) => get<CertsSnapshot>('/api/certs', signal),
  restartGuest: (vmid: number, type: 'lxc' | 'qemu') =>
    post<{ ok: boolean }>(`/api/system/guests/${vmid}/restart?type=${type}`),
  guestTasks: (vmid: number, signal?: AbortSignal) =>
    get<{ tasks: GuestTask[] }>(`/api/system/guests/${vmid}/tasks?limit=8`, signal),
  taskLog: (upid: string, signal?: AbortSignal) =>
    get<{ lines: { n: number; t: string }[] }>(
      `/api/system/tasks/${encodeURIComponent(upid)}/log?limit=300`,
      signal,
    ),
  guestJournal: (vmid: number, lastentries = 500, signal?: AbortSignal) =>
    get<{ vmid: number; lines: string[]; note: string }>(
      `/api/system/guests/${vmid}/journal?lastentries=${lastentries}`,
      signal,
    ),
  audit: (signal?: AbortSignal) =>
    get<{ events: Record<string, unknown>[] }>('/api/audit?limit=50', signal),
  verifyBackup: (backup_type: string, backup_id: string, backup_time: number) =>
    post<{ ok: boolean; upid: string }>('/api/backups/verify', {
      backup_type,
      backup_id,
      backup_time,
    }),
};

export { ApiError };
