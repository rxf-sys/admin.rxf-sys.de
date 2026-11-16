import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors.ts';

type Role = 'viewer' | 'operator' | 'admin';

/** Every route declares who may call it (ADR 0005). Sessions and role checks arrive with the auth module. */
interface RouteAuth {
  role: 'public' | Role;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

/**
 * Default deny: registering a route without `config.auth` fails at startup, and every non-public
 * route answers 401 until a session proves otherwise.
 */
export function registerRouteGuard(app: FastifyInstance): void {
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
    if (!SAFE_METHODS.has(request.method)) assertSameOrigin(request);
    if (auth.role !== 'public') throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  });
}
