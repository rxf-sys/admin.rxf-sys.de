import {
  catalogResponse,
  createInstanceRequest,
  instanceListResponse,
  instanceResponse,
  testResultResponse,
  updateInstanceRequest,
} from '@rxf/contracts';
import { createHttpClient, createNetClient, type ServerPlugin, type TestResult } from '@rxf/sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod/mini';
import { recordAudit } from '../audit.ts';
import type { Session } from '../auth/sessions.ts';
import type { Scheduler } from '../collect/scheduler.ts';
import type { EntityStore } from '../data/entities.ts';
import type { Db } from '../db/database.ts';
import { AppError } from '../http/errors.ts';
import type { EventBus } from '../stream/bus.ts';
import type { PluginHost } from './host.ts';
import type { InstanceRow, InstanceStore } from './instances.ts';

export interface PluginRouteDeps {
  db: Db;
  store: InstanceStore;
  host: PluginHost;
  scheduler: Scheduler;
  entities: EntityStore;
  bus: EventBus;
  now: () => number;
}

const TEST_TIMEOUT_MS = 10_000;
const TEST_TOTAL_MS = 60_000;
const idParams = z.object({ id: z.string().check(z.regex(/^[0-9a-f-]{36}$/)) });
const ok = z.object({ ok: z.literal(true) });

export function registerPluginRoutes(app: FastifyInstance, deps: PluginRouteDeps): void {
  const { db, host, now, store, scheduler, entities, bus } = deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const session = (request: FastifyRequest): Session => {
    if (!request.session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    return request.session;
  };
  const elevated = (s: Session) => s.elevatedUntil !== null && s.elevatedUntil > now();
  const audit = (request: FastifyRequest, entry: Parameters<typeof recordAudit>[1]) =>
    recordAudit(
      db,
      { actorIp: request.ip, actorUserId: request.session?.userId ?? null, targetType: 'plugin_instance', ...entry },
      now,
    );

  async function withPlugin(row: InstanceRow): Promise<ServerPlugin> {
    return host.load(row.pluginId);
  }
  const view = (plugin: ServerPlugin, row: InstanceRow) => store.view(plugin, row, scheduler.health(row.id));

  /** Starts collectors; a failure is logged and leaves the instance active but idle. */
  async function startCollectors(request: FastifyRequest, row: InstanceRow): Promise<void> {
    try {
      await scheduler.start(row);
    } catch (error) {
      request.log.error({ instanceId: row.id, err: error }, 'collectors could not start');
    }
  }

  /** Runs the plugin's test() through an HTTP client limited to the instance's own targets and requests. */
  async function runTest(request: FastifyRequest, row: InstanceRow): Promise<TestResult> {
    const plugin = await withPlugin(row);
    const { config, secretValues } = store.runtimeConfig(row);
    const typed = plugin.config.schema.parse(config);
    const targets = plugin.targets(typed);
    const allowBlockedAddresses = plugin.allowBlockedAddresses?.(typed) ?? false;
    const http = createHttpClient({
      targets,
      requests: plugin.requests.collect,
      timeoutMs: TEST_TIMEOUT_MS,
      allowBlockedAddresses,
    });
    const net = createNetClient({ targets, timeoutMs: TEST_TIMEOUT_MS, allowBlockedAddresses });
    try {
      return await plugin.test({
        config: typed,
        secrets: secretValues,
        http,
        net,
        log: request.log.child({ instanceId: row.id, pluginId: row.pluginId }),
        now,
        signal: AbortSignal.timeout(TEST_TOTAL_MS),
      });
    } finally {
      await http.close();
    }
  }

  api.get(
    '/api/plugins/catalog',
    { config: { auth: { role: 'viewer' } }, schema: { response: { 200: catalogResponse } } },
    async () => ({
      plugins: host.catalog().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category,
        icon: m.icon,
        version: m.version,
        multiInstance: m.multiInstance,
      })),
    }),
  );

  api.get(
    '/api/instances',
    { config: { auth: { role: 'viewer' } }, schema: { response: { 200: instanceListResponse } } },
    async () => {
      const rows = store.list();
      const views = await Promise.all(rows.map(async (row) => view(await withPlugin(row), row)));
      return { instances: views };
    },
  );

  api.get(
    '/api/instances/:id',
    { config: { auth: { role: 'viewer' } }, schema: { params: idParams, response: { 200: instanceResponse } } },
    async (request) => {
      const row = store.get(request.params.id);
      return view(await withPlugin(row), row);
    },
  );

  api.post(
    '/api/instances',
    {
      // A new instance brings targets and secrets: admin with a fresh re-authentication (ADR 0005, 0008).
      config: { auth: { role: 'admin', elevated: true } },
      schema: { body: createInstanceRequest, response: { 201: instanceResponse } },
    },
    async (request, reply) => {
      const { pluginId } = request.body;
      const manifest = host.manifest(pluginId);
      if (!manifest.multiInstance && store.countFor(pluginId) > 0) {
        throw new AppError(409, 'SINGLE_INSTANCE', `${manifest.name.en} can only be added once`);
      }
      const plugin = await host.load(pluginId);
      const row = store.create(plugin, request.body, session(request).userId);
      audit(request, {
        event: 'instance.created',
        result: 'success',
        targetId: row.id,
        instanceId: row.id,
        details: { pluginId },
      });
      return reply.code(201).send(view(plugin, row));
    },
  );

  api.patch(
    '/api/instances/:id',
    {
      config: { auth: { role: 'admin' } },
      schema: { params: idParams, body: updateInstanceRequest, response: { 200: instanceResponse } },
    },
    async (request) => {
      const row = store.get(request.params.id);
      const plugin = await withPlugin(row);
      const touched = store.sensitiveFieldsTouched(plugin, row, request.body.config);
      if (touched.length > 0 && !elevated(session(request))) {
        throw new AppError(403, 'REAUTH_REQUIRED', 'Changing targets or secrets needs a fresh confirmation', {
          fields: touched,
        });
      }
      const updated = store.update(plugin, row, request.body);
      // New targets or secrets take effect with fresh collectors.
      if (updated.status === 'active') await scheduler.restart(updated);
      const changed = [...(request.body.name ? ['name'] : []), ...Object.keys(request.body.config ?? {})];
      audit(request, {
        event: 'instance.updated',
        result: 'success',
        targetId: row.id,
        instanceId: row.id,
        details: { changed },
      });
      return view(plugin, updated);
    },
  );

  api.post(
    '/api/instances/:id/test',
    { config: { auth: { role: 'admin' } }, schema: { params: idParams, response: { 200: testResultResponse } } },
    async (request) => {
      const row = store.get(request.params.id);
      const result = await runTest(request, row);
      audit(request, {
        event: 'instance.tested',
        result: result.ok ? 'success' : 'failure',
        targetId: row.id,
        instanceId: row.id,
      });
      return result;
    },
  );

  api.post(
    '/api/instances/:id/activate',
    { config: { auth: { role: 'admin' } }, schema: { params: idParams, response: { 200: instanceResponse } } },
    async (request) => {
      const row = store.get(request.params.id);
      if (row.status !== 'draft')
        throw new AppError(409, 'INVALID_STATE', `The instance is ${row.status}, not a draft`);
      // draft → active only after a successful test (ADR 0003).
      const result = await runTest(request, row);
      if (!result.ok) {
        audit(request, { event: 'instance.activated', result: 'failure', targetId: row.id, instanceId: row.id });
        throw new AppError(409, 'TEST_FAILED', 'The connection test failed', { capabilities: result.capabilities });
      }
      const active = store.setStatus(row, 'active');
      audit(request, { event: 'instance.activated', result: 'success', targetId: row.id, instanceId: row.id });
      await startCollectors(request, active);
      return view(await withPlugin(row), active);
    },
  );

  for (const [action, from, to] of [
    ['pause', 'active', 'paused'],
    ['resume', 'paused', 'active'],
  ] as const) {
    api.post(
      `/api/instances/:id/${action}`,
      { config: { auth: { role: 'admin' } }, schema: { params: idParams, response: { 200: instanceResponse } } },
      async (request) => {
        const row = store.get(request.params.id);
        if (row.status !== from) throw new AppError(409, 'INVALID_STATE', `The instance is ${row.status}, not ${from}`);
        const updated = store.setStatus(row, to);
        audit(request, { event: `instance.${action}d`, result: 'success', targetId: row.id, instanceId: row.id });
        if (to === 'paused') {
          // Collectors stop and the entities show "paused" (ADR 0003).
          await scheduler.stop(row.id);
          const kinds = entities.markPaused(row.id, now());
          if (kinds.length > 0) bus.publish('entities', { instanceId: row.id, kinds, version: now() });
          bus.publish('instance', { instanceId: row.id, status: 'paused', health: 'idle' });
        } else {
          await startCollectors(request, updated);
        }
        return view(await withPlugin(row), updated);
      },
    );
  }

  api.delete(
    '/api/instances/:id',
    { config: { auth: { role: 'admin', elevated: true } }, schema: { params: idParams, response: { 200: ok } } },
    async (request) => {
      const row = store.get(request.params.id);
      await scheduler.stop(row.id);
      // Entities, series and values go with the instance through the foreign keys (ADR 0004).
      store.delete(row);
      bus.publish('instance', { instanceId: row.id, status: 'deleted', health: 'idle' });
      audit(request, {
        event: 'instance.deleted',
        result: 'success',
        targetId: row.id,
        details: { pluginId: row.pluginId, name: row.name },
      });
      return { ok: true as const };
    },
  );
}
