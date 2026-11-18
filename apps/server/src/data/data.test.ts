import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../db/database.ts';
import { testDatabase } from '../test-support.ts';
import { EntityStore, InvalidSnapshotError } from './entities.ts';
import { pruneMetrics, queryPoints, RETENTION, rollUpMetrics } from './metrics.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 17, 12);

let database: DatabaseHandle;
let store: EntityStore;

function addInstance(id: string) {
  database.sqlite
    .prepare(
      "INSERT INTO plugin_instances (id, plugin_id, name, status, config_json, created_at, updated_at) VALUES (?, 'uptime', 'U', 'active', '{}', 0, 0)",
    )
    .run(id);
}

const service = (externalId: string, status: 'ok' | 'warn' | 'crit' = 'ok') => ({
  kind: 'Service' as const,
  externalId,
  name: externalId.toUpperCase(),
  status,
});
const metric = (externalId: string, value: number, ts?: number) => ({
  entity: { kind: 'Service' as const, externalId },
  name: 'uptime.response_ms',
  unit: 'ms',
  value,
  ...(ts === undefined ? {} : { ts }),
});

beforeEach(() => {
  database = testDatabase();
  store = new EntityStore(database);
  addInstance('i1');
  addInstance('i2');
});

afterEach(() => {
  database.sqlite.close();
});

describe('EntityStore.applySnapshot', () => {
  it('upserts entities, appends metrics and reports kinds and series', () => {
    const first = store.applySnapshot(
      'i1',
      'http',
      { entities: [service('a'), service('b', 'crit')], metrics: [metric('a', 12), metric('b', 30)] },
      T0,
      MIN,
    );
    expect(first.kinds).toEqual(['Service']);
    expect(first.seriesIds).toHaveLength(2);

    const second = store.applySnapshot(
      'i1',
      'http',
      {
        entities: [{ ...service('a', 'warn'), statusReason: 'HTTP_SLOW', attrs: { endpoint: 'https://x/' } }],
        metrics: [metric('a', 900)],
      },
      T0 + 1_000,
      MIN,
    );
    expect(second.seriesIds).toEqual([first.seriesIds[0]]);
    const [a, b] = store.list({ instanceId: 'i1' });
    expect(a).toMatchObject({
      externalId: 'a',
      pluginId: 'uptime',
      status: 'warn',
      statusReason: 'HTTP_SLOW',
      attrs: { endpoint: 'https://x/' },
      lastSeen: T0 + 1_000,
    });
    // Missing, but still inside the grace period.
    expect(b).toMatchObject({ externalId: 'b', status: 'crit', lastSeen: T0 });
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM metric_raw').get()).toEqual({ n: 3 });
  });

  it('marks entities of the same collector unknown once they are missing longer than the grace period', () => {
    store.applySnapshot('i1', 'http', { entities: [service('a'), service('b')], metrics: [] }, T0, MIN);
    store.applySnapshot('i1', 'tcp', { entities: [service('c')], metrics: [] }, T0, MIN);
    const later = store.applySnapshot('i1', 'http', { entities: [service('a')], metrics: [] }, T0 + 2 * MIN, MIN);
    expect(later.kinds).toEqual(['Service']);
    const byId = Object.fromEntries(store.list({ instanceId: 'i1' }).map((e) => [e.externalId, e]));
    expect(byId.b).toMatchObject({ status: 'unknown', statusReason: 'MISSING' });
    // Another collector's entity is not touched.
    expect(byId.c?.status).toBe('ok');

    // An empty snapshot ages out everything of that collector.
    store.applySnapshot('i1', 'http', { entities: [], metrics: [] }, T0 + 4 * MIN, MIN);
    expect(store.list({ instanceId: 'i1' }).filter((e) => e.status === 'unknown')).toHaveLength(2);
  });

  it.each([
    ['a status only the core may set', { entities: [{ ...service('a'), status: 'paused' }], metrics: [] }],
    ['a duplicate entity', { entities: [service('a'), service('a')], metrics: [] }],
    ['a metric for an entity outside the snapshot', { entities: [service('a')], metrics: [metric('zzz', 1)] }],
    ['oversized attrs', { entities: [{ ...service('a'), attrs: { blob: 'x'.repeat(20_000) } }], metrics: [] }],
    ['a non-finite value', { entities: [service('a')], metrics: [metric('a', Number.NaN)] }],
    ['a bad reason code', { entities: [{ ...service('a'), statusReason: 'see http://evil' }], metrics: [] }],
    ['no arrays at all', { nope: true }],
  ])('rejects %s without writing anything', (_label, snapshot) => {
    expect(() => store.applySnapshot('i1', 'http', snapshot, T0, MIN)).toThrow(InvalidSnapshotError);
    expect(store.list({})).toEqual([]);
  });

  it('pauses all entities of an instance and filters lists', () => {
    store.applySnapshot('i1', 'http', { entities: [service('a')], metrics: [] }, T0, MIN);
    store.applySnapshot('i2', 'http', { entities: [service('a')], metrics: [] }, T0, MIN);
    expect(store.markPaused('i1', T0 + 1)).toEqual(['Service']);
    expect(store.list({ instanceId: 'i1' })[0]?.status).toBe('paused');
    expect(store.list({ instanceId: 'i2' })[0]?.status).toBe('ok');
    expect(store.list({ kind: 'Host' })).toEqual([]);
    expect(store.list({ kind: 'Service' })).toHaveLength(2);
    expect(store.markPaused('missing', T0)).toEqual([]);
  });
});

describe('metric tiers', () => {
  function seed(values: [ts: number, value: number][]) {
    store.applySnapshot(
      'i1',
      'http',
      { entities: [service('a')], metrics: values.map(([ts, value]) => metric('a', value, ts)) },
      T0,
      DAY,
    );
    return (database.sqlite.prepare('SELECT id FROM metric_series').get() as { id: number }).id;
  }

  it('rolls raw values into weighted 5-minute and hourly buckets, idempotently', () => {
    const base = Date.UTC(2026, 10, 17, 10); // full hour
    const id = seed([
      [base, 10],
      [base + MIN, 20],
      [base + 5 * MIN, 30],
      [base + HOUR + MIN, 99], // in the current, open hour/bucket at "now"
    ]);
    const now = base + HOUR + 2 * MIN;
    expect(rollUpMetrics(database.sqlite, now)).toEqual({ fiveMin: 2, hour: 1 });
    const five = database.sqlite.prepare('SELECT bucket, avg, min, max, count FROM metric_5m ORDER BY bucket').all();
    expect(five).toEqual([
      { bucket: base, avg: 15, min: 10, max: 20, count: 2 },
      { bucket: base + 5 * MIN, avg: 30, min: 30, max: 30, count: 1 },
    ]);
    // Hourly mean is weighted by count: (15 × 2 + 30) / 3 = 20.
    expect(database.sqlite.prepare('SELECT bucket, avg, count FROM metric_1h').all()).toEqual([
      { bucket: base, avg: 20, count: 3 },
    ]);

    // Running again changes nothing; later runs also pick up the bucket that was open before.
    rollUpMetrics(database.sqlite, now);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM metric_5m').get()).toEqual({ n: 2 });
    rollUpMetrics(database.sqlite, base + HOUR + 10 * MIN);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM metric_5m').get()).toEqual({ n: 3 });

    expect(queryPoints(database.sqlite, id, base, base + HOUR)).toMatchObject({
      resolution: 'raw',
      points: [
        { ts: base, avg: 10 },
        { ts: base + MIN, avg: 20 },
        { ts: base + 5 * MIN, avg: 30 },
      ],
    });
  });

  it('does nothing on empty tables and picks tiers by window length', () => {
    expect(rollUpMetrics(database.sqlite, T0)).toEqual({ fiveMin: 0, hour: 0 });
    const id = seed([[T0 - 10 * MIN, 1]]);
    expect(queryPoints(database.sqlite, id, T0 - 3 * DAY, T0).resolution).toBe('5m');
    const year = queryPoints(database.sqlite, id, T0 - 300 * DAY, T0);
    expect(year.resolution).toBe('1h');
    expect((300 * DAY) / year.stepMs).toBeLessThanOrEqual(1_000);
  });

  it('downsamples raw data to at most ~1,000 points', () => {
    const values: [number, number][] = [];
    for (let i = 0; i < 2_880; i++) values.push([T0 - DAY + i * 30_000, i % 2]);
    const id = seed(values);
    const result = queryPoints(database.sqlite, id, T0 - DAY, T0);
    expect(result.points.length).toBeLessThanOrEqual(1_000);
    expect(result.points.some((p) => p.min === 0 && p.max === 1)).toBe(true);
  });

  it('prunes each tier after its retention', () => {
    const id = seed([
      [T0 - RETENTION.rawMs - 1, 1],
      [T0 - 1_000, 2],
    ]);
    const insert = (table: string, bucket: number) =>
      database.sqlite
        .prepare(`INSERT INTO ${table} (series_id, bucket, avg, min, max, count) VALUES (?, ?, 1, 1, 1, 1)`)
        .run(id, bucket);
    insert('metric_5m', T0 - RETENTION.fiveMinMs - 1);
    insert('metric_5m', T0 - DAY);
    insert('metric_1h', T0 - RETENTION.hourMs - 1);
    insert('metric_1h', T0 - DAY);
    expect(pruneMetrics(database.sqlite, T0)).toBe(3);
    for (const table of ['metric_raw', 'metric_5m', 'metric_1h']) {
      expect(database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    }
  });
});
