import type {
  AccessSessions,
  Account,
  BackupHeatmap,
  BackupStorage,
  BackupSummary,
  CertsSnapshot,
  GuestBackups,
  GuestHistory,
  GuestTask,
  Identity,
  NetworkSnapshot,
  NetworkThroughput,
  Role,
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

async function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new ApiError(r.status, text);
  }
  return r.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) => send<T>('POST', path, body);

/** Pull a human-readable message out of an ApiError's JSON body. */
export function apiErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const parsed = JSON.parse(e.body) as { detail?: string };
      if (parsed.detail) return parsed.detail;
    } catch {
      /* body wasn't JSON */
    }
    return e.body || `Fehler ${e.status}`;
  }
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}

export const api = {
  me: (signal?: AbortSignal) => get<Identity>('/api/me', signal),

  // --- Authentication ---
  authMe: (signal?: AbortSignal) => get<{ user: Account }>('/api/auth/me', signal),
  login: (username: string, password: string) =>
    post<{ user: Account }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),

  // --- Own account ---
  getAccountSettings: (signal?: AbortSignal) =>
    get<{ settings: Record<string, unknown> }>('/api/account/settings', signal),
  putAccountSettings: (settings: Record<string, unknown>) =>
    send<{ ok: boolean }>('PUT', '/api/account/settings', { settings }),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: boolean }>('/api/account/password', { current_password, new_password }),

  // --- Admin: user management ---
  adminListUsers: (signal?: AbortSignal) =>
    get<{ users: Account[] }>('/api/admin/users', signal),
  adminCreateUser: (body: { username: string; password: string; role: Role; email?: string | null }) =>
    post<{ user: Account }>('/api/admin/users', body),
  adminUpdateUser: (id: number, body: { role?: Role; email?: string | null; disabled?: boolean }) =>
    send<{ user: Account }>('PATCH', `/api/admin/users/${id}`, body),
  adminResetPassword: (id: number, new_password: string) =>
    post<{ ok: boolean }>(`/api/admin/users/${id}/password`, { new_password }),
  adminDeleteUser: (id: number) =>
    send<{ ok: boolean }>('DELETE', `/api/admin/users/${id}`),

  system: (signal?: AbortSignal) => get<SystemSnapshot>('/api/system', signal),
  services: (signal?: AbortSignal) => get<ServiceStatus[]>('/api/services', signal),
  serviceHistory: (id: string, hours = 24, signal?: AbortSignal) =>
    get<ServiceHistory>(`/api/services/${encodeURIComponent(id)}/history?hours=${hours}`, signal),
  tunnel: (signal?: AbortSignal) => get<TunnelStatus>('/api/tunnel', signal),
  backups: (signal?: AbortSignal) => get<BackupSummary>('/api/backups', signal),
  backupsHeatmap: (days = 30, signal?: AbortSignal) =>
    get<BackupHeatmap>(`/api/backups/heatmap?days=${days}`, signal),
  backupsStorageByGuest: (signal?: AbortSignal) =>
    get<BackupStorage>('/api/backups/storage-by-guest', signal),
  network: (signal?: AbortSignal) => get<NetworkSnapshot>('/api/network', signal),
  networkThroughput: (hours = 1, signal?: AbortSignal) =>
    get<NetworkThroughput>(`/api/network/throughput?hours=${hours}`, signal),
  certs: (signal?: AbortSignal) => get<CertsSnapshot>('/api/certs', signal),
  cfAccessSessions: (hours = 24, signal?: AbortSignal) =>
    get<AccessSessions>(`/api/cloudflare/access/sessions?hours=${hours}`, signal),
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
  guestHistory: (vmid: number, hours = 24, signal?: AbortSignal) =>
    get<GuestHistory>(`/api/system/guests/${vmid}/history?hours=${hours}`, signal),
  guestBackups: (vmid: number, limit = 5, signal?: AbortSignal) =>
    get<GuestBackups>(`/api/system/guests/${vmid}/backups?limit=${limit}`, signal),
  audit: (signal?: AbortSignal) =>
    get<{ events: Record<string, unknown>[] }>('/api/audit?limit=50', signal),
  events: (limit = 50, signal?: AbortSignal) =>
    get<{ events: Record<string, unknown>[] }>(`/api/events?limit=${limit}`, signal),
  verifyBackup: (backup_type: string, backup_id: string, backup_time: number) =>
    post<{ ok: boolean; upid: string }>('/api/backups/verify', {
      backup_type,
      backup_id,
      backup_time,
    }),
};

export { ApiError };
