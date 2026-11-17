import { healthResponse } from '@rxf/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadCommonPasswords } from './auth/passwords.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { resolveSession } from './auth/sessions.ts';
import type { MasterKey } from './crypto/master-key.ts';
import type { DatabaseHandle } from './db/database.ts';
import { AppError, registerErrorHandling } from './http/errors.ts';
import { registerRouteGuard } from './http/route-auth.ts';
import { PluginHost } from './plugins/host.ts';
import { registerPluginRoutes } from './plugins/routes.ts';
import { pluginRegistry, type RegisteredPlugin } from './plugins.generated.ts';

export interface AppOptions {
  /** Reported by `/api/healthz`; set from the image tag at build time. */
  version: string;
  database: DatabaseHandle;
  masterKey: MasterKey;
  logger?: FastifyServerOptions['logger'];
  /** Proxies whose X-Forwarded-For is believed (Caddy's address); empty means the socket address counts. */
  trustedProxies?: readonly string[];
  commonPasswords?: ReadonlySet<string>;
  now?: () => number;
  /** Defaults to the generated registry; tests pass their own. */
  plugins?: readonly RegisteredPlugin[];
}

export function buildApp(options: AppOptions): FastifyInstance {
  const now = options.now ?? Date.now;
  const trusted = options.trustedProxies ?? [];
  const app = Fastify({ logger: options.logger ?? false, trustProxy: trusted.length > 0 ? [...trusted] : false });
  const db = options.database.db;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerRouteGuard(app, { resolve: (token) => resolveSession(db, token, now()), now });
  registerErrorHandling(app);

  // Caddy adds the full header set (ADR 0008); API answers must never be cached or sniffed in any case.
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
  });

  const ping = options.database.sqlite.prepare('SELECT 1');
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/api/healthz',
      { config: { auth: { role: 'public' } }, schema: { response: { 200: healthResponse } } },
      async () => {
        try {
          ping.get();
        } catch {
          // The driver error may name file paths; the status code says enough to the health check.
          throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database does not answer');
        }
        return { status: 'ok' as const, version: options.version };
      },
    );

  registerAuthRoutes(app, {
    db,
    masterKey: options.masterKey,
    commonPasswords: options.commonPasswords ?? loadCommonPasswords(),
    now,
  });
  registerPluginRoutes(app, {
    db,
    masterKey: options.masterKey,
    host: new PluginHost(options.plugins ?? pluginRegistry),
    now,
  });

  return app;
}
