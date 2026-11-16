import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { AppError, registerErrorHandling } from './errors.ts';

async function appWith(register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  register(app);
  await app.ready();
  return app;
}

describe('error handling', () => {
  it('passes AppError code, message and details through', async () => {
    const app = await appWith((a) =>
      a.get('/conflict', async () => {
        throw new AppError(409, 'NAME_TAKEN', 'An instance with this name exists', { field: 'name' });
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/conflict' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'NAME_TAKEN', message: 'An instance with this name exists', details: { field: 'name' } },
    });
  });

  it('reports schema violations without echoing the submitted value', async () => {
    const app = await appWith((a) =>
      a.post('/items', { schema: { body: z.object({ count: z.number() }) } }, async () => ({ ok: true })),
    );
    const res = await app.inject({ method: 'POST', url: '/items', payload: { count: 'secret-value-123' } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.in).toBe('body');
    expect(body.error.details.issues[0].path).toBe('/count');
    expect(res.body).not.toContain('secret-value-123');
  });

  it('keeps Fastify client errors as 4xx with their code', async () => {
    const app = await appWith((a) => a.post('/items', async () => ({ ok: true })));
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');
  });

  it('hides internal errors behind a generic 500', async () => {
    const app = await appWith((a) =>
      a.get('/boom', async () => {
        throw new Error('SQLITE_CORRUPT at /data/rxf-admin-v2.db');
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
});
