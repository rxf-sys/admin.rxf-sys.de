import { healthResponse } from '@rxf/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DatabaseHandle } from './db/database.ts';
import { AppError, registerErrorHandling } from './http/errors.ts';
import { registerRouteGuard } from './http/route-auth.ts';

export interface AppOptions {
  /** Reported by `/api/healthz`; set from the image tag at build time. */
  version: string;
  database: DatabaseHandle;
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerRouteGuard(app);
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

  return app;
}
