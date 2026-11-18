import { type SessionResponse, sessionResponse } from '@rxf/contracts';
import { useQuery } from '@tanstack/react-query';
import { getJson, setCsrfToken } from './api.ts';

export const sessionKey = ['session'] as const;

async function loadSession(): Promise<SessionResponse> {
  const session = await getJson('/api/auth/session', sessionResponse);
  setCsrfToken(session.authenticated ? session.csrfToken : null);
  return session;
}

export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: loadSession, retry: false, staleTime: 60_000 });
}

/** Where a visitor belongs, derived from the session alone (ADR 0005: the second factor is mandatory). */
export type Stage = 'setup' | 'login' | 'verify' | 'enrol' | 'app';

export function stageOf(session: SessionResponse): Stage {
  if (!session.authenticated) return session.setupOpen ? 'setup' : 'login';
  if (session.mfa === 'pending') return 'verify';
  if (session.mfa === 'setup_required') return 'enrol';
  return 'app';
}

/** The one path each pre-app stage may show; the app stage owns every other path. */
export const stagePaths: Record<Exclude<Stage, 'app'>, string> = {
  setup: '/setup',
  login: '/login',
  verify: '/login/verify',
  enrol: '/enrol',
};
