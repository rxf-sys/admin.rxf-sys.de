import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { DatabaseHandle } from './db/database.ts';
import { testDatabase, testMasterKey } from './test-support.ts';

describe('app', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeEach(() => {
    database = testDatabase();
    app = buildApp({ version: '2.0.0-test', database, masterKey: testMasterKey(), commonPasswords: new Set() });
  });

  afterEach(async () => {
    await app.close();
    if (database.sqlite.open) database.sqlite.close();
  });

  it('reports the server as up with its version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '2.0.0-test' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers HEAD for health checks', async () => {
    expect((await app.inject({ method: 'HEAD', url: '/api/healthz' })).statusCode).toBe(200);
  });

  it('reports 503 when the database is gone', async () => {
    database.sqlite.close();
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The database does not answer' } });
  });

  it('answers unknown routes with the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/unknown?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'GET /api/unknown does not exist' } });
  });
});

describe('client address', () => {
  it('believes X-Forwarded-For only from a trusted proxy', async () => {
    const { auditEvents } = await import('./db/schema.ts');
    for (const [trustedProxies, expected] of [
      [[], '127.0.0.1'],
      [['127.0.0.1'], '203.0.113.9'],
    ] as const) {
      const database = testDatabase();
      const app = buildApp({
        version: 't',
        database,
        masterKey: testMasterKey(),
        commonPasswords: new Set(),
        trustedProxies,
      });
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        payload: { username: 'nobody', password: 'whatever it is' },
      });
      expect(database.db.select().from(auditEvents).get()?.actorIp).toBe(expected);
      await app.close();
    }
  });
});
