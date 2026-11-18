import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { watchRequest } from '@rxf/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod/mini';
import { readSessionToken, resolveSession } from '../auth/sessions.ts';
import type { Scheduler } from '../collect/scheduler.ts';
import type { Db } from '../db/database.ts';
import { AppError } from '../http/errors.ts';
import type { BusEvent, EventBus } from './bus.ts';

export interface StreamRouteDeps {
  db: Db;
  bus: EventBus;
  scheduler: Scheduler;
  now: () => number;
  /** Shorter in tests. */
  heartbeatMs?: number;
}

/** Cloudflare closes idle connections after about 100 s (ADR 0007). */
const HEARTBEAT_MS = 25_000;
/** Bytes a slow client may fall behind before the server drops it; it then reconnects with a resync. */
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_CONNECTIONS_PER_SESSION = 10;
const MAX_CONNECTIONS = 200;

interface Connection {
  sessionHash: string;
  res: ServerResponse;
}

function frame(event: { id?: string; type: string; data: unknown }): string {
  const id = event.id ? `id: ${event.id}\n` : '';
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function registerStreamRoutes(app: FastifyInstance, deps: StreamRouteDeps): void {
  const { db, bus, scheduler, now } = deps;
  const connections = new Map<string, Connection>();
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Before the server stops accepting: open streams would otherwise keep close() waiting forever.
  app.addHook('preClose', async () => {
    for (const connection of connections.values()) connection.res.destroy();
  });

  api.get('/api/stream', { config: { auth: { role: 'viewer' } } }, async (request, reply) => {
    const session = request.session;
    const token = readSessionToken(request.headers.cookie);
    if (!session || !token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const own = [...connections.values()].filter((c) => c.sessionHash === session.tokenHash).length;
    if (own >= MAX_CONNECTIONS_PER_SESSION || connections.size >= MAX_CONNECTIONS) {
      throw new AppError(429, 'TOO_MANY_STREAMS', 'Too many open live connections');
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Keeps any buffering proxy from holding events back; Caddy also sets flush_interval -1.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    const connectionId = randomBytes(16).toString('base64url');
    connections.set(connectionId, { sessionHash: session.tokenHash, res });

    const send = (chunk: string) => {
      if (res.destroyed) return;
      if (res.writableLength > MAX_PENDING_BYTES) {
        res.destroy();
        return;
      }
      res.write(chunk);
    };
    send(frame({ type: 'hello', data: { connectionId } }));

    const lastEventId = request.headers['last-event-id'];
    if (typeof lastEventId === 'string') {
      const missed = bus.since(lastEventId);
      if (missed === null) send(frame({ type: 'resync', data: {} }));
      else for (const event of missed) send(frame(event));
    }
    const unsubscribe = bus.subscribe((event: BusEvent) => send(frame(event)));

    // The heartbeat also re-checks the session without extending it, so logout, revocation and timeouts
    // end the stream within one beat (ADR 0005, 0007).
    const heartbeat = setInterval(() => {
      if (!resolveSession(db, token, now(), { touch: false })) {
        send(frame({ type: 'session', data: { revoked: true } }));
        res.end();
        return;
      }
      send(': ping\n\n');
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref();

    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      connections.delete(connectionId);
      scheduler.unwatch(connectionId);
    });
  });

  api.post(
    '/api/stream/watch',
    {
      config: { auth: { role: 'viewer' } },
      schema: { body: watchRequest, response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (request) => {
      const connection = connections.get(request.body.connectionId);
      // Only the session that opened a stream may steer it.
      if (!connection || connection.sessionHash !== request.session?.tokenHash) {
        throw new AppError(404, 'STREAM_NOT_FOUND', 'There is no such live connection');
      }
      scheduler.watch(request.body.connectionId, [...new Set(request.body.instanceIds)]);
      return { ok: true as const };
    },
  );
}
