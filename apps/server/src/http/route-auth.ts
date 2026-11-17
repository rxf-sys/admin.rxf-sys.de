import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Role, readSessionToken, type Session } from '../auth/sessions.ts';
import { safeEqual } from '../auth/tokens.ts';
import { AppError } from './errors.ts';

/**
 * Every route declares who may call it (ADR 0005, default deny):
 * - `role`: minimum role, or `public`
 * - `mfa: 'optional'`: also reachable before the second factor is done (enrolment, verification, logout)
 * - `csrf: false`: skip the synchronizer token on a state-changing route (only for public sign-in routes)
 * - `elevated`: needs a re-authentication within the last 10 minutes
 */
interface RouteAuth {
  role: 'public' | Role;
  mfa?: 'required' | 'optional';
  csrf?: boolean;
  elevated?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    session: Session | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

function originHost(origin: string): string | null {
  return URL.canParse(origin) ? new URL(origin).host : null;
}

/** Browsers send Sec-Fetch-Site and Origin with every state-changing request; both must point at us. */
function assertSameOrigin(request: FastifyRequest): void {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    throw new AppError(403, 'CROSS_SITE_REQUEST', 'Cross-site requests are not allowed');
  }
  const origin = request.headers.origin;
  if (origin !== undefined && originHost(origin) !== request.headers.host) {
    throw new AppError(403, 'CROSS_SITE_REQUEST', 'Cross-site requests are not allowed');
  }
}

interface GuardDeps {
  resolve: (token: string) => Session | null;
  now: () => number;
}

/**
 * Registering a route without `config.auth` fails at startup. On each request the session cookie is
 * resolved, then role, second factor, CSRF token and re-authentication are checked in that order.
 */
export function registerRouteGuard(app: FastifyInstance, deps: GuardDeps): void {
  app.decorateRequest('session', null);

  app.addHook('onRoute', (route) => {
    if (!route.config?.auth) {
      const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
      throw new Error(`${methods} ${route.url} has no config.auth declaration (default deny, ADR 0005)`);
    }
  });

  app.addHook('onRequest', async (request) => {
    const auth = request.routeOptions.config.auth;
    // Requests without a matched route go to the 404 handler and never reach a handler.
    if (!auth) return;
    const unsafe = !SAFE_METHODS.has(request.method);
    if (unsafe) assertSameOrigin(request);

    const token = readSessionToken(request.headers.cookie);
    request.session = token ? deps.resolve(token) : null;
    if (auth.role === 'public') return;

    const session = request.session;
    if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (RANK[session.role] < RANK[auth.role]) throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this');
    if (auth.mfa !== 'optional' && !session.mfaDone) {
      throw new AppError(403, 'MFA_REQUIRED', 'Complete the second factor first');
    }
    if (unsafe && auth.csrf !== false) {
      const sent = request.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !safeEqual(sent, session.csrfToken)) {
        throw new AppError(403, 'CSRF_TOKEN_INVALID', 'The CSRF token is missing or wrong');
      }
    }
    if (auth.elevated && !(session.elevatedUntil !== null && session.elevatedUntil > deps.now())) {
      throw new AppError(403, 'REAUTH_REQUIRED', 'Confirm your identity again to do this');
    }
  });
}
