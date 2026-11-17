import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineConfig, defineServerPlugin, field, originOf, PluginHttpError, type PluginManifest } from '@rxf/sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { auditEvents, pluginInstances, secrets, users } from '../db/schema.ts';
import type { RegisteredPlugin } from '../plugins.generated.ts';
import { elevate, type SignedInClient, signedInAdmin, type TestApp, testApp } from '../test-support.ts';

let device: Server;
let deviceUrl: string;
const seenAuth: string[] = [];

beforeAll(async () => {
  device = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    res.writeHead(req.url === '/broken' ? 500 : 200).end('ok');
  });
  await new Promise<void>((resolve) => device.listen(0, '127.0.0.1', resolve));
  deviceUrl = `http://127.0.0.1:${(device.address() as AddressInfo).port}`;
});

afterAll(() => {
  device.close();
});

const manifest = (id: string, multiInstance = false): PluginManifest => ({
  id,
  name: { de: id, en: id },
  description: { de: 'Test', en: 'Test' },
  version: '0.1.0',
  core: '^2.0.0',
  icon: 'box',
  category: 'monitoring',
  multiInstance,
});

/** A plugin with a secret, an admin-only target and a real HTTP call in test(). */
const fixture = defineServerPlugin({
  config: defineConfig({
    url: field(z.string(), { label: { de: 'URL', en: 'URL' }, adminOnly: true }),
    token: field(z.string().check(z.minLength(8)), { label: { de: 'Token', en: 'Token' }, secret: true }),
    note: field(z.optional(z.string()), { label: { de: 'Notiz', en: 'Note' } }),
  }),
  targets: (cfg) => [{ origin: originOf(cfg.url), tls: { mode: 'system' } }],
  allowBlockedAddresses: () => true,
  requests: { collect: [{ method: 'GET', path: '/**' }] },
  async test(ctx) {
    try {
      const res = await ctx.http.request('GET', ctx.config.url, {
        headers: { authorization: `Bearer ${ctx.secrets.token}` },
      });
      return { ok: res.status === 200, capabilities: [{ id: 'read', status: res.status === 200 ? 'ok' : 'failed' }] };
    } catch (error) {
      const code = error instanceof PluginHttpError ? error.code : 'UNKNOWN';
      return { ok: false, capabilities: [{ id: 'read', status: 'failed', code }] };
    }
  },
});

const loads: string[] = [];
const loader = (id: string) => async () => {
  loads.push(id);
  return { default: fixture as never };
};
const registry: RegisteredPlugin[] = [
  { manifest: manifest('fixture'), load: loader('fixture') },
  { manifest: manifest('never-used', true), load: loader('never-used') },
];

describe('plugins and instances', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let admin: SignedInClient;

  beforeEach(async () => {
    loads.length = 0;
    t = testApp(undefined, registry);
    app = t.app;
    admin = await signedInAdmin(t);
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (client: SignedInClient) => ({
    cookie: `__Host-rxf_session=${client.token}`,
    'x-csrf-token': client.csrf,
  });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, client = admin) =>
    app.inject(
      payload === undefined ? { method, url, headers: as(client) } : { method, url, headers: as(client), payload },
    );

  async function createFixture(config: Record<string, unknown> = { url: `${deviceUrl}/`, token: 'secret-token-123' }) {
    await elevate(t, admin);
    const res = await call('POST', '/api/instances', { pluginId: 'fixture', name: 'Device', config });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  it('lists the catalog from manifests without loading plugin code', async () => {
    const res = await call('GET', '/api/plugins/catalog');
    expect(res.json().plugins.map((p: { id: string }) => p.id)).toEqual(['fixture', 'never-used']);
    expect(loads).toEqual([]);
  });

  it('creates a draft with the secret sealed and never returned', async () => {
    const created = await createFixture();
    expect(created).toMatchObject({
      status: 'draft',
      config: { url: `${deviceUrl}/` },
      secrets: { token: { set: true, updatedAt: t.clock.now } },
    });
    expect(JSON.stringify(created)).not.toContain('secret-token-123');
    const row = t.database.db.select().from(pluginInstances).get();
    expect(row?.configJson).not.toContain('secret-token-123');
    const stored = t.database.db.select().from(secrets).get();
    expect(stored?.ciphertext.toString('utf8')).not.toContain('secret-token-123');
    expect(loads).toEqual(['fixture']);
  });

  it('needs an admin with a fresh re-authentication to create', async () => {
    const res = await call('POST', '/api/instances', { pluginId: 'fixture', name: 'x', config: {} });
    expect(res.json().error.code).toBe('REAUTH_REQUIRED');
    t.database.db.update(users).set({ role: 'operator' }).run();
    expect((await call('GET', '/api/instances')).statusCode).toBe(200);
    expect((await call('POST', '/api/instances', { pluginId: 'fixture', name: 'x', config: {} })).statusCode).toBe(403);
  });

  it('rejects invalid config without echoing values and refuses a second single instance', async () => {
    await elevate(t, admin);
    const bad = await call('POST', '/api/instances', {
      pluginId: 'fixture',
      name: 'x',
      config: { url: `${deviceUrl}/`, token: 'short' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_CONFIG');
    expect(bad.body).not.toContain('short');
    await createFixture();
    const second = await call('POST', '/api/instances', {
      pluginId: 'fixture',
      name: 'y',
      config: { url: `${deviceUrl}/`, token: 'secret-token-123' },
    });
    expect(second.json().error.code).toBe('SINGLE_INSTANCE');
    expect((await call('POST', '/api/instances', { pluginId: 'nope', name: 'z', config: {} })).statusCode).toBe(404);
  });

  it('asks for re-authentication only when targets or secrets change; an empty secret keeps the old one', async () => {
    const { id } = await createFixture();
    t.clock.now += 11 * 60_000; // elevation has expired
    const rename = await call('PATCH', `/api/instances/${id}`, { name: 'Renamed', config: { note: 'hi', token: '' } });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: 'Renamed', config: { note: 'hi' }, secrets: { token: { set: true } } });
    const target = await call('PATCH', `/api/instances/${id}`, { config: { url: `${deviceUrl}/broken` } });
    expect(target.json().error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { fields: ['url'] } });
    const secret = await call('PATCH', `/api/instances/${id}`, { config: { token: 'another-secret-456' } });
    expect(secret.json().error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { fields: ['token'] } });
    await elevate(t, admin);
    expect((await call('PATCH', `/api/instances/${id}`, { config: { token: 'another-secret-456' } })).statusCode).toBe(
      200,
    );
  });

  it('tests with the decrypted secret, activates only after a passing test, pauses and resumes', async () => {
    const { id } = await createFixture({ url: `${deviceUrl}/broken`, token: 'secret-token-123' });
    const failing = await call('POST', `/api/instances/${id}/activate`);
    expect(failing.json().error.code).toBe('TEST_FAILED');

    await elevate(t, admin);
    await call('PATCH', `/api/instances/${id}`, { config: { url: `${deviceUrl}/` } });
    const tested = await call('POST', `/api/instances/${id}/test`);
    expect(tested.json()).toEqual({ ok: true, capabilities: [{ id: 'read', status: 'ok' }] });
    expect(seenAuth.at(-1)).toBe('Bearer secret-token-123');

    expect((await call('POST', `/api/instances/${id}/activate`)).json().status).toBe('active');
    expect((await call('POST', `/api/instances/${id}/activate`)).json().error.code).toBe('INVALID_STATE');
    expect((await call('POST', `/api/instances/${id}/pause`)).json().status).toBe('paused');
    expect((await call('POST', `/api/instances/${id}/pause`)).json().error.code).toBe('INVALID_STATE');
    expect((await call('POST', `/api/instances/${id}/resume`)).json().status).toBe('active');
  });

  it('deletes with re-authentication and takes the secrets along', async () => {
    const { id } = await createFixture();
    t.clock.now += 11 * 60_000;
    expect((await call('DELETE', `/api/instances/${id}`)).json().error.code).toBe('REAUTH_REQUIRED');
    await elevate(t, admin);
    expect((await call('DELETE', `/api/instances/${id}`)).statusCode).toBe(200);
    expect(t.database.db.select().from(secrets).all()).toEqual([]);
    expect((await call('GET', `/api/instances/${id}`)).statusCode).toBe(404);
  });

  it('audits every change without secret values', async () => {
    const { id } = await createFixture();
    await call('POST', `/api/instances/${id}/test`);
    const events = t.database.db
      .select()
      .from(auditEvents)
      .all()
      .map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['instance.created', 'instance.tested']));
    expect(JSON.stringify(t.database.db.select().from(auditEvents).all())).not.toContain('secret-token-123');
  });
});
