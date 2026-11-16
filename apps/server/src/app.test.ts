import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

describe('GET /api/healthz', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ version: '2.0.0-test' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports the server as up with its version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '2.0.0-test' });
  });

  it('answers unknown routes with 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/unknown' });
    expect(res.statusCode).toBe(404);
  });
});
