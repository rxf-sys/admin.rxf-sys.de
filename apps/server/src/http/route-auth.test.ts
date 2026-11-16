import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandling } from './errors.ts';
import { registerRouteGuard } from './route-auth.ts';

async function guardedApp() {
  const app = Fastify();
  registerRouteGuard(app);
  registerErrorHandling(app);
  app.get('/api/open', { config: { auth: { role: 'public' } } }, async () => ({ ok: true }));
  app.post('/api/open', { config: { auth: { role: 'public' } } }, async () => ({ ok: true }));
  app.get('/api/admin', { config: { auth: { role: 'admin' } } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('route guard', () => {
  it('refuses to register a route without an auth declaration', async () => {
    const app = Fastify();
    registerRouteGuard(app);
    expect(() => app.get('/api/forgotten', async () => ({}))).toThrow(/GET \/api\/forgotten has no config.auth/);
  });

  it('lets public routes through', async () => {
    const app = await guardedApp();
    expect((await app.inject({ method: 'GET', url: '/api/open' })).statusCode).toBe(200);
  });

  it('answers 401 on every non-public route until sessions exist', async () => {
    const app = await guardedApp();
    const res = await app.inject({ method: 'GET', url: '/api/admin' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site sibling', { 'sec-fetch-site': 'same-site' }],
    ['a foreign origin', { origin: 'https://evil.example', host: 'admin-next.rxf-sys.de' }],
    ['an opaque origin', { origin: 'null', host: 'admin-next.rxf-sys.de' }],
  ])('blocks state-changing requests from %s', async (_, headers) => {
    const app = await guardedApp();
    const res = await app.inject({ method: 'POST', url: '/api/open', headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CROSS_SITE_REQUEST');
  });

  it.each([
    [
      'the same origin',
      { 'sec-fetch-site': 'same-origin', origin: 'https://admin-next.rxf-sys.de', host: 'admin-next.rxf-sys.de' },
    ],
    ['a non-browser client', {}],
  ])('allows state-changing requests from %s', async (_, headers) => {
    const app = await guardedApp();
    expect((await app.inject({ method: 'POST', url: '/api/open', headers })).statusCode).toBe(200);
  });

  it('does not apply the origin check to reads', async () => {
    const app = await guardedApp();
    const res = await app.inject({ method: 'GET', url: '/api/open', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(200);
  });
});
