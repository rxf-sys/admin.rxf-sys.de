import type { HealthResponse } from '@rxf/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  /** Reported by `/api/healthz`; set from the image tag at build time. */
  version: string;
  logger?: boolean;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get(
    '/api/healthz',
    async (): Promise<HealthResponse> => ({
      status: 'ok',
      version: options.version,
    }),
  );

  return app;
}
