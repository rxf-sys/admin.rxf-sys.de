import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type CollectResult, defineConfig, defineServerPlugin, field } from '@rxf/sdk';
import * as OTPAuth from 'otpauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import type { RegisteredPlugin } from '../plugins.generated.ts';
import {
  elevate,
  type SignedInClient,
  sessionTokenFrom,
  signedInAdmin,
  type TestApp,
  testApp,
} from '../test-support.ts';

let collected: CollectResult;
let runs = 0;

const fake = defineServerPlugin({
  config: defineConfig({ label: field(z.string(), { label: { de: 'L', en: 'L' } }) }),
  targets: () => [],
  requests: { collect: [] },
  test: async () => ({ ok: true, capabilities: [] }),
  collectors: [
    {
      id: 'main',
      interval: { activeMs: 60_000, backgroundMs: 600_000 },
      timeoutMs: 1_000,
      run: async () => {
        runs += 1;
        return collected;
      },
    },
  ],
});

const registry: RegisteredPlugin[] = [
  {
    manifest: {
      id: 'fake',
      name: { de: 'Fake', en: 'Fake' },
      description: { de: 'x', en: 'x' },
      version: '0.1.0',
      core: '^2.0.0',
      icon: 'box',
      category: 'monitoring',
      multiInstance: true,
    },
    load: async () => ({ default: fake as never }),
  },
];

let t: TestApp;
let admin: SignedInClient;
let base: string;

const headers = (client: SignedInClient) => ({
  cookie: `__Host-rxf_session=${client.token}`,
  'x-csrf-token': client.csrf,
});

beforeEach(async () => {
  runs = 0;
  collected = {
    entities: [{ kind: 'Service', externalId: 'web', name: 'Web', status: 'ok', attrs: { endpoint: 'https://web/' } }],
    metrics: [{ entity: { kind: 'Service', externalId: 'web' }, name: 'uptime.response_ms', unit: 'ms', value: 42 }],
  };
  t = testApp(undefined, registry, { collectors: true, heartbeatMs: 40 });
  admin = await signedInAdmin(t);
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await t.app.close();
  t.database.sqlite.close();
});

/** Opens the event stream and collects frames until the test is done with it. */
function openStream(client: SignedInClient, extra: Record<string, string> = {}) {
  let body = '';
  let response: IncomingMessage | undefined;
  const request = get(`${base}/api/stream`, { headers: { cookie: headers(client).cookie, ...extra } }, (res) => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      body += chunk;
    });
  });
  request.on('error', () => {});
  return {
    get body() {
      return body;
    },
    get response() {
      return response;
    },
    events: () =>
      body
        .split('\n\n')
        .filter((block) => block.includes('event: '))
        .map((block) => ({
          id: /^id: (.+)$/m.exec(block)?.[1],
          type: /^event: (.+)$/m.exec(block)?.[1] as string,
          data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null'),
        })),
    close: () => request.destroy(),
  };
}

async function createActiveInstance(): Promise<string> {
  await elevate(t, admin);
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/instances',
    headers: headers(admin),
    payload: { pluginId: 'fake', name: 'Fake', config: { label: 'x' } },
  });
  const id = created.json().id as string;
  const activated = await t.app.inject({
    method: 'POST',
    url: `/api/instances/${id}/activate`,
    headers: headers(admin),
  });
  expect(activated.statusCode).toBe(200);
  return id;
}

describe('instance lifecycle with collectors', () => {
  it('collects after activation, pauses, resumes and removes everything on delete', async () => {
    const id = await createActiveInstance();
    await vi.waitFor(() => expect(runs).toBe(1));

    const list = await t.app.inject({ method: 'GET', url: `/api/entities?instanceId=${id}`, headers: headers(admin) });
    const [entity] = list.json().entities;
    expect(entity).toMatchObject({
      pluginId: 'fake',
      kind: 'Service',
      status: 'ok',
      attrs: { endpoint: 'https://web/' },
    });
    const instance = await t.app.inject({ method: 'GET', url: `/api/instances/${id}`, headers: headers(admin) });
    expect(instance.json().health).toBe('ok');

    const series = await t.app.inject({
      method: 'GET',
      url: `/api/metrics/series?entityId=${entity.id}`,
      headers: headers(admin),
    });
    const [s] = series.json().series;
    expect(s).toMatchObject({ name: 'uptime.response_ms', unit: 'ms' });
    const points = await t.app.inject({
      method: 'GET',
      url: `/api/metrics/series/${s.id}/points?from=${t.clock.now - 60_000}&to=${t.clock.now + 60_000}`,
      headers: headers(admin),
    });
    expect(points.json()).toMatchObject({ seriesId: s.id, resolution: 'raw', points: [{ avg: 42, min: 42, max: 42 }] });

    const pause = await t.app.inject({ method: 'POST', url: `/api/instances/${id}/pause`, headers: headers(admin) });
    expect(pause.json()).toMatchObject({ status: 'paused', health: 'idle' });
    const paused = await t.app.inject({ method: 'GET', url: '/api/entities?kind=Service', headers: headers(admin) });
    expect(paused.json().entities[0].status).toBe('paused');

    await t.app.inject({ method: 'POST', url: `/api/instances/${id}/resume`, headers: headers(admin) });
    await vi.waitFor(() => expect(runs).toBe(2));

    // A config change restarts the collectors, so they run again with the new config.
    await t.app.inject({
      method: 'PATCH',
      url: `/api/instances/${id}`,
      headers: headers(admin),
      payload: { config: { label: 'y' } },
    });
    await vi.waitFor(() => expect(runs).toBe(3));

    await elevate(t, admin);
    await t.app.inject({ method: 'DELETE', url: `/api/instances/${id}`, headers: headers(admin) });
    const after = await t.app.inject({ method: 'GET', url: '/api/entities', headers: headers(admin) });
    expect(after.json().entities).toEqual([]);
    const gone = await t.app.inject({
      method: 'GET',
      url: `/api/metrics/series/${s.id}/points`,
      headers: headers(admin),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('starts active instances when the server becomes ready', async () => {
    const id = await createActiveInstance();
    await vi.waitFor(() => expect(runs).toBe(1));
    const restarted = testApp(undefined, registry, { collectors: true });
    // Same database file content is not shared between apps; copy the instance row over.
    const row = t.database.sqlite.prepare('SELECT * FROM plugin_instances WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    restarted.database.sqlite
      .prepare(
        'INSERT INTO plugin_instances (id, plugin_id, name, status, config_json, created_at, updated_at) VALUES (@id, @plugin_id, @name, @status, @config_json, @created_at, @updated_at)',
      )
      .run(row);
    await restarted.app.ready();
    await vi.waitFor(() => expect(runs).toBe(2));
    await restarted.app.close();
    restarted.database.sqlite.close();
  });

  it('rejects empty or too long ranges and unknown series', async () => {
    const call = (url: string) => t.app.inject({ method: 'GET', url, headers: headers(admin) });
    expect((await call('/api/metrics/series/1/points?from=10&to=10')).json().error.code).toBe('INVALID_RANGE');
    expect((await call('/api/metrics/series/1/points?from=0&to=40000000000')).statusCode).toBe(400);
    expect((await call('/api/metrics/series/999/points')).statusCode).toBe(404);
    expect((await call('/api/entities?kind=Nope')).statusCode).toBe(400);
  });
});

describe('GET /api/stream', () => {
  it('needs a signed-in session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/stream' });
    expect(res.statusCode).toBe(401);
  });

  it('greets, streams changes without entity data and lets the tab choose what it watches', async () => {
    const stream = openStream(admin);
    await vi.waitFor(() => expect(stream.events()[0]?.type).toBe('hello'));
    expect(stream.response?.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.response?.headers['cache-control']).toBe('no-store');
    const { connectionId } = (stream.events()[0] as { data: { connectionId: string } }).data;

    const id = await createActiveInstance();
    await vi.waitFor(() => expect(stream.events().some((e) => e.type === 'metrics')).toBe(true));
    const types = stream.events().map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['instance', 'entities', 'metrics']));
    expect(stream.body).not.toContain('https://web/');
    expect(stream.events().find((e) => e.type === 'entities')?.data).toMatchObject({
      instanceId: id,
      kinds: ['Service'],
    });

    // Watching the instance pulls a run forward.
    const watch = await t.app.inject({
      method: 'POST',
      url: '/api/stream/watch',
      headers: headers(admin),
      payload: { connectionId, instanceIds: [id] },
    });
    expect(watch.statusCode).toBe(200);
    await vi.waitFor(() => expect(runs).toBe(2));

    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/stream/watch',
      headers: headers(admin),
      payload: { connectionId: 'A'.repeat(22), instanceIds: [] },
    });
    expect(unknown.json().error.code).toBe('STREAM_NOT_FOUND');
    stream.close();
  });

  it('replays missed events after Last-Event-ID and asks for a resync when it cannot', async () => {
    const first = openStream(admin);
    await createActiveInstance();
    await vi.waitFor(() => expect(first.events().some((e) => e.type === 'metrics')).toBe(true));
    const events = first.events().filter((e) => e.id);
    first.close();

    const replay = openStream(admin, { 'last-event-id': events[0]?.id as string });
    await vi.waitFor(() => expect(replay.events().filter((e) => e.id).length).toBe(events.length - 1));
    replay.close();

    const resync = openStream(admin, { 'last-event-id': '00000000-1' });
    await vi.waitFor(() => expect(resync.events().map((e) => e.type)).toEqual(['hello', 'resync']));
    resync.close();
  });

  it('ends the stream within one heartbeat after logout', async () => {
    const stream = openStream(admin);
    await vi.waitFor(() => expect(stream.body).toContain(': ping'));
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(admin) });
    await vi.waitFor(() => expect(stream.events().at(-1)?.type).toBe('session'));
    expect(stream.events().at(-1)?.data).toEqual({ revoked: true });
    await vi.waitFor(() => expect(stream.response?.complete).toBe(true));
  });

  it('only lets the session that opened a stream steer it, and caps connections per session', async () => {
    const stream = openStream(admin);
    await vi.waitFor(() => expect(stream.events()[0]?.type).toBe('hello'));
    const { connectionId } = (stream.events()[0] as { data: { connectionId: string } }).data;

    // Second session of the same account (password + TOTP).
    t.clock.now += 60_000;
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'robin', password: 'correct horse battery staple' },
    });
    const pendingToken = sessionTokenFrom(login) as string;
    const csrfOf = async (token: string) =>
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: `__Host-rxf_session=${token}` },
        })
      ).json().csrfToken as string;
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(admin.totpSecret) }).generate({
      timestamp: t.clock.now,
    });
    const verified = await t.app.inject({
      method: 'POST',
      url: '/api/auth/2fa',
      headers: { cookie: `__Host-rxf_session=${pendingToken}`, 'x-csrf-token': await csrfOf(pendingToken) },
      payload: { code },
    });
    const otherToken = sessionTokenFrom(verified) as string;
    const other = { token: otherToken, csrf: await csrfOf(otherToken), totpSecret: admin.totpSecret };
    const foreign = await t.app.inject({
      method: 'POST',
      url: '/api/stream/watch',
      headers: headers(other),
      payload: { connectionId, instanceIds: [] },
    });
    expect(foreign.json().error.code).toBe('STREAM_NOT_FOUND');

    const more = Array.from({ length: 9 }, () => openStream(admin));
    await vi.waitFor(() => expect(more.every((s) => s.events().length > 0)).toBe(true));
    const tooMany = openStream(admin);
    await vi.waitFor(() => expect(tooMany.response?.statusCode).toBe(429));
    for (const s of [stream, ...more, tooMany]) s.close();
  });
});
