import type {
  BackupSummary,
  CertsSnapshot,
  GuestTask,
  Identity,
  NetworkSnapshot,
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
  tunnel: (signal?: AbortSignal) => get<TunnelStatus>('/api/tunnel', signal),
  backups: (signal?: AbortSignal) => get<BackupSummary>('/api/backups', signal),
  network: (signal?: AbortSignal) => get<NetworkSnapshot>('/api/network', signal),
  certs: (signal?: AbortSignal) => get<CertsSnapshot>('/api/certs', signal),
  restartGuest: (vmid: number, type: 'lxc' | 'qemu') =>
    post<{ ok: boolean }>(`/api/system/guests/${vmid}/restart?type=${type}`),
  guestTasks: (vmid: number, signal?: AbortSignal) =>
    get<{ tasks: GuestTask[] }>(`/api/system/guests/${vmid}/tasks?limit=8`, signal),
};

export { ApiError };
