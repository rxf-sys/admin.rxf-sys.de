import type { MetricPointsResponse } from '@rxf/contracts';
import type Database from 'better-sqlite3';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Retention per tier (ADR 0004). Configurable through `settings` once that table exists. */
export const RETENTION = { rawMs: 2 * DAY, fiveMinMs: 30 * DAY, hourMs: 365 * DAY } as const;

const FIVE_MIN = 5 * MINUTE;
const MAX_POINTS = 1_000;

interface MetricWrite {
  entityId: number;
  name: string;
  unit: string;
  value: number;
  ts: number;
}

const statements = new WeakMap<Database.Database, ReturnType<typeof prepare>>();

function prepare(sqlite: Database.Database) {
  return {
    findSeries: sqlite.prepare<[number, string], { id: number }>(
      'SELECT id FROM metric_series WHERE entity_id = ? AND name = ?',
    ),
    insertSeries: sqlite.prepare<[number, string, string], { id: number }>(
      'INSERT INTO metric_series (entity_id, name, unit) VALUES (?, ?, ?) RETURNING id',
    ),
    insertRaw: sqlite.prepare<[number, number, number]>(
      'INSERT INTO metric_raw (series_id, ts, value) VALUES (?, ?, ?) ON CONFLICT (series_id, ts) DO UPDATE SET value = excluded.value',
    ),
  };
}

function statementsFor(sqlite: Database.Database) {
  let prepared = statements.get(sqlite);
  if (!prepared) {
    prepared = prepare(sqlite);
    statements.set(sqlite, prepared);
  }
  return prepared;
}

/** Appends raw values, creating series on first use. Runs inside the caller's transaction. */
export function writeMetrics(sqlite: Database.Database, values: readonly MetricWrite[]): number[] {
  const s = statementsFor(sqlite);
  const seriesIds = new Set<number>();
  for (const value of values) {
    const id =
      s.findSeries.get(value.entityId, value.name)?.id ??
      (s.insertSeries.get(value.entityId, value.name, value.unit) as { id: number }).id;
    s.insertRaw.run(id, value.ts, value.value);
    seriesIds.add(id);
  }
  return [...seriesIds];
}

/**
 * Folds completed buckets into the 5-minute and hourly tiers (ADR 0004). Idempotent: it recomputes from the
 * newest stored bucket on, so a repeated or interrupted run converges to the same rows.
 */
export function rollUpMetrics(sqlite: Database.Database, now: number): { fiveMin: number; hour: number } {
  const startOf = (table: string, column: string, fallbackTable: string, fallbackColumn: string, floor: number) => {
    const newest = sqlite.prepare(`SELECT max(${column}) AS v FROM ${table}`).get() as { v: number | null };
    const oldest = sqlite.prepare(`SELECT min(${fallbackColumn}) AS v FROM ${fallbackTable}`).get() as {
      v: number | null;
    };
    const from = newest.v ?? oldest.v;
    return from === null ? null : Math.max(from, floor);
  };

  return sqlite.transaction(() => {
    let fiveMin = 0;
    let hour = 0;
    const fiveEnd = Math.floor(now / FIVE_MIN) * FIVE_MIN;
    const fiveStart = startOf('metric_5m', 'bucket', 'metric_raw', 'ts', now - RETENTION.rawMs);
    if (fiveStart !== null && fiveStart < fiveEnd) {
      fiveMin = sqlite
        .prepare(
          `INSERT INTO metric_5m (series_id, bucket, avg, min, max, count)
           SELECT series_id, (ts / ${FIVE_MIN}) * ${FIVE_MIN} AS b, avg(value), min(value), max(value), count(*)
           FROM metric_raw WHERE ts >= ? AND ts < ? GROUP BY series_id, b
           ON CONFLICT (series_id, bucket) DO UPDATE SET
             avg = excluded.avg, min = excluded.min, max = excluded.max, count = excluded.count`,
        )
        .run(Math.floor(fiveStart / FIVE_MIN) * FIVE_MIN, fiveEnd).changes;
    }
    const hourEnd = Math.floor(now / HOUR) * HOUR;
    const hourStart = startOf('metric_1h', 'bucket', 'metric_5m', 'bucket', now - RETENTION.fiveMinMs);
    if (hourStart !== null && hourStart < hourEnd) {
      hour = sqlite
        .prepare(
          `INSERT INTO metric_1h (series_id, bucket, avg, min, max, count)
           SELECT series_id, (bucket / ${HOUR}) * ${HOUR} AS b, sum(avg * count) / sum(count), min(min), max(max), sum(count)
           FROM metric_5m WHERE bucket >= ? AND bucket < ? GROUP BY series_id, b
           ON CONFLICT (series_id, bucket) DO UPDATE SET
             avg = excluded.avg, min = excluded.min, max = excluded.max, count = excluded.count`,
        )
        .run(Math.floor(hourStart / HOUR) * HOUR, hourEnd).changes;
    }
    return { fiveMin, hour };
  })();
}

/**
 * Deletes expired rows series by series, so each statement walks the primary key and stays short
 * (there is no index on `ts` alone).
 */
export function pruneMetrics(sqlite: Database.Database, now: number): number {
  const series = sqlite.prepare('SELECT id FROM metric_series').pluck().all() as number[];
  const deletes = [
    [sqlite.prepare('DELETE FROM metric_raw WHERE series_id = ? AND ts < ?'), now - RETENTION.rawMs],
    [sqlite.prepare('DELETE FROM metric_5m WHERE series_id = ? AND bucket < ?'), now - RETENTION.fiveMinMs],
    [sqlite.prepare('DELETE FROM metric_1h WHERE series_id = ? AND bucket < ?'), now - RETENTION.hourMs],
  ] as const;
  let removed = 0;
  for (const id of series) {
    for (const [statement, cutoff] of deletes) removed += statement.run(id, cutoff).changes;
  }
  return removed;
}

/**
 * Points of one series for a window. The tier follows the window length (≤ 48 h raw, ≤ 30 days 5 min,
 * else 1 h) and the result is bucketed to at most ~1,000 points (ADR 0004).
 */
export function queryPoints(
  sqlite: Database.Database,
  seriesId: number,
  from: number,
  to: number,
): Omit<MetricPointsResponse, 'seriesId'> {
  const window = Math.max(to - from, 1);
  const [resolution, tierStep] =
    window <= RETENTION.rawMs
      ? (['raw', 1_000] as const)
      : window <= RETENTION.fiveMinMs
        ? (['5m', FIVE_MIN] as const)
        : (['1h', HOUR] as const);
  const stepMs = Math.max(tierStep, Math.ceil(window / MAX_POINTS / tierStep) * tierStep);
  const query =
    resolution === 'raw'
      ? `SELECT (ts / CAST(@step AS INTEGER)) * CAST(@step AS INTEGER) AS ts, avg(value) AS avg, min(value) AS min, max(value) AS max
         FROM metric_raw WHERE series_id = @id AND ts >= @from AND ts < @to GROUP BY 1 ORDER BY 1`
      : `SELECT (bucket / CAST(@step AS INTEGER)) * CAST(@step AS INTEGER) AS ts, sum(avg * count) / sum(count) AS avg, min(min) AS min, max(max) AS max
         FROM ${resolution === '5m' ? 'metric_5m' : 'metric_1h'}
         WHERE series_id = @id AND bucket >= @from AND bucket < @to GROUP BY 1 ORDER BY 1`;
  // Bound JS numbers arrive as REAL; the casts keep the bucket division integral.
  const points = sqlite.prepare(query).all({ step: stepMs, id: seriesId, from, to }) as MetricPointsResponse['points'];
  return { resolution, stepMs, points };
}

/** Rolls up and prunes every five minutes; returns a stop function. */
export function startMetricMaintenance(
  sqlite: Database.Database,
  now: () => number,
  onError: (error: unknown) => void,
): () => void {
  const timer = setInterval(() => {
    try {
      rollUpMetrics(sqlite, now());
      pruneMetrics(sqlite, now());
    } catch (error) {
      onError(error);
    }
  }, FIVE_MIN);
  timer.unref();
  return () => clearInterval(timer);
}
