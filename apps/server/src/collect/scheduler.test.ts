import { type CollectResult, defineConfig, defineServerPlugin, field, type PluginContext } from '@rxf/sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { EntityStore } from '../data/entities.ts';
import type { DatabaseHandle } from '../db/database.ts';
import { PluginHost } from '../plugins/host.ts';
import { type InstanceRow, InstanceStore } from '../plugins/instances.ts';
import { type BusEvent, EventBus } from '../stream/bus.ts';
import { testDatabase, testMasterKey } from '../test-support.ts';
import { BREAKER_THRESHOLD, Scheduler, WATCH_GRACE_MS } from './scheduler.ts';

type Behaviour = (ctx: PluginContext<{ label: string }>) => Promise<CollectResult>;

const snapshot = (status: 'ok' | 'crit' = 'ok'): CollectResult => ({
  entities: [{ kind: 'Service', externalId: 'web', name: 'Web', status }],
  metrics: [{ entity: { kind: 'Service', externalId: 'web' }, name: 'uptime.status', unit: '', value: 1 }],
});

let behaviours: Behaviour[];
let calls: number;
let concurrent: number;
let maxSeen: number;

function plugin(maxConcurrent?: number, timeoutMs = 5_000) {
  const collector = (id: string) => ({
    id,
    interval: { activeMs: 10_000, backgroundMs: 60_000 },
    timeoutMs,
    async run(ctx: PluginContext<{ label: string }>) {
      calls += 1;
      concurrent += 1;
      maxSeen = Math.max(maxSeen, concurrent);
      try {
        const next = behaviours.shift() ?? (async () => snapshot());
        return await next(ctx);
      } finally {
        concurrent -= 1;
      }
    },
  });
  return defineServerPlugin({
    config: defineConfig({ label: field(z.string(), { label: { de: 'L', en: 'L' } }) }),
    targets: () => [],
    requests: { collect: [] },
    test: async () => ({ ok: true, capabilities: [] }),
    collectors: maxConcurrent ? [collector('a'), collector('b')] : [collector('a')],
    ...(maxConcurrent ? { maxConcurrent } : {}),
  });
}

const manifest = {
  id: 'fake',
  name: { de: 'Fake', en: 'Fake' },
  description: { de: 'x', en: 'x' },
  version: '0.1.0',
  core: '^2.0.0',
  icon: 'box',
  category: 'monitoring' as const,
  multiInstance: true,
};

const silent = {
  info() {},
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return silent;
  },
} as unknown as FastifyBaseLogger;

let database: DatabaseHandle;
let instances: InstanceStore;
let events: BusEvent[];

function setup(options: { maxConcurrent?: number; timeoutMs?: number; enabled?: boolean } = {}) {
  const fake = plugin(options.maxConcurrent, options.timeoutMs);
  const host = new PluginHost([{ manifest, load: async () => ({ default: fake as never }) }]);
  const bus = new EventBus(Date.now);
  bus.subscribe((event) => events.push(event));
  const scheduler = new Scheduler({
    host,
    instances,
    entities: new EntityStore(database),
    bus,
    log: silent,
    now: Date.now,
    enabled: options.enabled ?? true,
    random: () => 0.5,
  });
  const row = instances.setStatus(
    instances.create(fake as never, { pluginId: 'fake', name: 'F', config: { label: 'x' } }, 1),
    'active',
  );
  return { scheduler, row };
}

const statusOf = () =>
  (database.sqlite.prepare('SELECT status FROM entities').get() as { status: string } | undefined)?.status;
const healthEvents = () =>
  events.filter((e) => e.type === 'instance').map((e) => (e.data as { health: string }).health);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 17, 12));
  database = testDatabase();
  database.sqlite.prepare("INSERT INTO users (id, username, role, created_at) VALUES (1, 'a', 'admin', 0)").run();
  instances = new InstanceStore(database.db, testMasterKey(), Date.now);
  behaviours = [];
  calls = 0;
  concurrent = 0;
  maxSeen = 0;
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
  database.sqlite.close();
});

describe('Scheduler', () => {
  it('runs at once, writes the snapshot and then follows the background interval with jitter', async () => {
    const { scheduler, row } = setup();
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(statusOf()).toBe('ok');
    expect(events.map((e) => e.type)).toEqual(['instance', 'entities', 'metrics']);
    expect(scheduler.health(row.id)).toBe('ok');

    // random() = 0.5 → no jitter offset: exactly 60 s.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await scheduler.stopAll();
  });

  it('does nothing when disabled or for an instance that is already running', async () => {
    const off = setup({ enabled: false });
    await off.scheduler.start(off.row);
    expect(off.scheduler.isRunning(off.row.id)).toBe(false);

    const { scheduler, row } = setup();
    await scheduler.start(row);
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await scheduler.stopAll();
  });

  it('pulls a run forward when someone starts watching and keeps the active interval for a grace period', async () => {
    const { scheduler, row } = setup();
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    scheduler.watch('conn-1', [row.id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);

    // A second viewer of the same instance does not pull forward again.
    scheduler.watch('conn-2', [row.id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);

    scheduler.unwatch('conn-1');
    scheduler.watch('conn-2', []);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(4);
    // After the grace period the next run waits the background interval.
    await vi.advanceTimersByTimeAsync(WATCH_GRACE_MS);
    const before = calls;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toBeLessThanOrEqual(before + 1);
    await scheduler.stopAll();
  });

  it('backs off, opens the circuit after three failures and closes it after a good trial run', async () => {
    const { scheduler, row } = setup();
    const fail = async () => {
      throw new Error('device exploded');
    };
    behaviours = [fail, fail, fail, fail];
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.health(row.id)).toBe('failing');
    await vi.advanceTimersByTimeAsync(120_000); // 60 s × 2¹
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(240_000); // 60 s × 2²
    expect(calls).toBe(BREAKER_THRESHOLD);
    expect(scheduler.health(row.id)).toBe('breaker-open');

    // Half-open after 60 s: the trial fails, the circuit reopens for twice as long.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(4);
    expect(scheduler.health(row.id)).toBe('breaker-open');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(5);
    expect(scheduler.health(row.id)).toBe('ok');
    expect(healthEvents()).toEqual(['ok', 'failing', 'breaker-open', 'ok']);
    // Only the error class reaches the log, never the message from the device.
    expect(JSON.stringify((silent.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('exploded');
    await scheduler.stopAll();
  });

  it('counts an invalid snapshot as a failure and writes nothing', async () => {
    const { scheduler, row } = setup();
    behaviours = [
      async () =>
        ({ entities: [{ kind: 'Service', externalId: 'x', name: 'X', status: 'paused' }], metrics: [] }) as never,
    ];
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.health(row.id)).toBe('failing');
    expect(statusOf()).toBeUndefined();
    await scheduler.stopAll();
  });

  it('aborts running collectors on stop and discards their result', async () => {
    const { scheduler, row } = setup();
    let seen: AbortSignal | undefined;
    behaviours = [
      (ctx) => {
        seen = ctx.signal;
        return new Promise((resolve) => setTimeout(() => resolve(snapshot()), 1_000));
      },
    ];
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop(row.id);
    expect(seen?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusOf()).toBeUndefined();
    expect(scheduler.isRunning(row.id)).toBe(false);
    expect(scheduler.health(row.id)).toBe('idle');
  });

  it('restarts with the current row', async () => {
    const { scheduler, row } = setup();
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.restart(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    await scheduler.stopAll();
  });

  it('limits concurrent runs per instance', async () => {
    const { scheduler, row } = setup({ maxConcurrent: 1 });
    const slow = () => new Promise<CollectResult>((resolve) => setTimeout(() => resolve(snapshot()), 500));
    behaviours = [slow, slow];
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(maxSeen).toBe(1);
    await scheduler.stopAll();
  });

  it('starts all active instances and logs those that cannot start', async () => {
    const { scheduler, row } = setup();
    const broken: InstanceRow = { ...row, id: '00000000-0000-0000-0000-000000000000', pluginId: 'missing' };
    database.sqlite
      .prepare(
        "INSERT INTO plugin_instances (id, plugin_id, name, status, config_json, created_at, updated_at) VALUES (?, 'missing', 'M', 'active', '{}', 0, 0)",
      )
      .run(broken.id);
    await scheduler.startAll();
    expect(scheduler.isRunning(row.id)).toBe(true);
    expect(silent.error).toHaveBeenCalled();
    await scheduler.stopAll();
  });
});

describe('Scheduler timeouts', () => {
  it('ends a collector that ignores its signal after timeoutMs', async () => {
    vi.useRealTimers();
    const { scheduler, row } = setup({ timeoutMs: 20 });
    behaviours = [() => new Promise(() => {})];
    await scheduler.start(row);
    await vi.waitFor(() => expect(scheduler.health(row.id)).toBe('failing'));
    const logged = JSON.stringify((silent.warn as ReturnType<typeof vi.fn>).mock.calls.at(-1));
    expect(logged).toContain('TIMEOUT');
    await scheduler.stopAll();
  });
});

describe('Scheduler with collectors from the config', () => {
  it('builds collectors per config, hands them the net client and removes entities of vanished ones', async () => {
    const seenNet: boolean[] = [];
    const derived = defineServerPlugin({
      config: defineConfig({ label: field(z.string(), { label: { de: 'L', en: 'L' } }) }),
      targets: () => [],
      requests: { collect: [] },
      test: async () => ({ ok: true, capabilities: [] }),
      collectors: (cfg) =>
        cfg.label.split(',').map((id) => ({
          id,
          interval: { activeMs: 10_000, backgroundMs: 60_000 },
          timeoutMs: 5_000,
          async run(ctx: PluginContext<{ label: string }>) {
            seenNet.push(typeof ctx.net.tcp === 'function');
            return {
              entities: [{ kind: 'Service' as const, externalId: id, name: id, status: 'ok' as const }],
              metrics: [],
            };
          },
        })),
    });
    const host = new PluginHost([{ manifest, load: async () => ({ default: derived as never }) }]);
    const bus = new EventBus(Date.now);
    bus.subscribe((event) => events.push(event));
    const entities = new EntityStore(database);
    const scheduler = new Scheduler({ host, instances, entities, bus, log: silent, now: Date.now, enabled: true });
    const row = instances.setStatus(
      instances.create(derived as never, { pluginId: 'fake', name: 'F', config: { label: 'a,b' } }, 1),
      'active',
    );
    await scheduler.start(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(entities.list({}).map((e) => e.externalId)).toEqual(['a', 'b']);
    expect(seenNet).toEqual([true, true]);

    const updated = instances.update(derived as never, row, { config: { label: 'a' } });
    events = [];
    await scheduler.restart(updated);
    expect(entities.list({}).map((e) => e.externalId)).toEqual(['a']);
    expect(events.find((e) => e.type === 'entities')?.data).toMatchObject({ instanceId: row.id, kinds: ['Service'] });
    await scheduler.stopAll();
  });
});
