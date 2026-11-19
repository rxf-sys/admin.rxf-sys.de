import Database from 'better-sqlite3';
import { recordAudit } from '../audit.ts';
import type { DatabaseHandle } from '../db/database.ts';
import { RETENTION } from './metrics.ts';

const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;

/** Why a v1 service brought no history along. */
type SkipReason = 'NO_CHECK' | 'NOT_RUN_YET' | 'NO_OLDER_DATA';

interface ServiceReport {
  serviceId: string;
  serviceName: string;
  check: string | null;
  /** Probe rows taken over. */
  rows: number;
  from: number | null;
  to: number | null;
  skipped?: SkipReason;
}

export interface LegacyImportReport {
  instanceId: string;
  instanceName: string;
  services: ServiceReport[];
  /** Rows of services v1 no longer knows (deleted services); dropped by owner decision 19.11.2026. */
  orphanRows: number;
  dryRun: boolean;
}

export class LegacyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

interface V1Row {
  ts: number;
  status: string;
  response_ms: number;
}

interface Bucket {
  sum: number;
  min: number;
  max: number;
  count: number;
}

/** Same spelling as v1 stored and v2 expects, e.g. `http://nas` and `http://nas/` match. */
function normaliseUrl(url: string): string {
  const trimmed = url.trim();
  return URL.canParse(trimmed) ? new URL(trimmed).href : trimmed;
}

function addTo(buckets: Map<number, Bucket>, bucket: number, value: number): void {
  const current = buckets.get(bucket);
  if (current) {
    current.sum += value;
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    current.count += 1;
  } else {
    buckets.set(bucket, { sum: value, min: value, max: value, count: 1 });
  }
}

/** Raw values inside the raw retention plus 5-minute and hourly buckets, like the core's own tiers. */
function tiers(values: readonly [ts: number, value: number][], now: number) {
  const raw = values.filter(([ts]) => ts >= now - RETENTION.rawMs);
  const fiveMin = new Map<number, Bucket>();
  const hour = new Map<number, Bucket>();
  for (const [ts, value] of values) {
    const five = Math.floor(ts / FIVE_MIN) * FIVE_MIN;
    if (five >= now - RETENTION.fiveMinMs) addTo(fiveMin, five, value);
    const h = Math.floor(ts / HOUR) * HOUR;
    if (h >= now - RETENTION.hourMs) addTo(hour, h, value);
  }
  return { raw, fiveMin, hour };
}

function openV1(path: string): Database.Database {
  let v1: Database.Database | undefined;
  try {
    v1 = new Database(path, { readonly: true, fileMustExist: true });
    const tables = new Set(v1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
    if (tables.has('custom_services') && tables.has('probe_history')) return v1;
  } catch {
    v1?.close();
    throw new LegacyImportError(`cannot open ${path} read-only as an SQLite database`);
  }
  v1.close();
  throw new LegacyImportError(`${path} is not a v1 database (custom_services or probe_history missing)`);
}

function targetInstance(handle: DatabaseHandle, instanceId: string | undefined) {
  const rows = handle.sqlite
    .prepare(
      "SELECT id, name, config_json AS configJson FROM plugin_instances WHERE plugin_id = 'uptime' ORDER BY name",
    )
    .all() as { id: string; name: string; configJson: string }[];
  const matching = instanceId ? rows.filter((row) => row.id === instanceId) : rows;
  if (matching.length === 1) return matching[0] as (typeof rows)[number];
  if (matching.length === 0) {
    throw new LegacyImportError(instanceId ? `no uptime instance ${instanceId}` : 'there is no uptime instance yet');
  }
  const list = rows.map((row) => `${row.id} (${row.name})`).join(', ');
  throw new LegacyImportError(`several uptime instances, choose one with --instance: ${list}`);
}

/**
 * Takes the probe history of v1 over (ADR 0001 §6, docs/integrations/uptime.md): each v1 service lands on
 * the v2 HTTP check whose URL equals its internal URL, as `uptime.status` (ok/warn → 1, err → 0) and
 * `uptime.response_ms` (successful probes only). Only values older than the check's first v2 value are
 * taken, so v2 data always wins and a second run adds nothing. The v1 file is opened read-only and only
 * `custom_services` and `probe_history` are read: it also holds v1 accounts and secrets.
 */
export function importV1Uptime(
  handle: DatabaseHandle,
  v1Path: string,
  options: { instanceId?: string | undefined; dryRun: boolean; now: number },
): LegacyImportReport {
  const instance = targetInstance(handle, options.instanceId);
  const config = JSON.parse(instance.configJson) as { checks?: { type?: string; name: string; url?: string }[] };
  const checkByUrl = new Map<string, string>();
  for (const check of config.checks ?? []) {
    if ((check.type === undefined || check.type === 'http') && check.url) {
      const key = normaliseUrl(check.url);
      if (!checkByUrl.has(key)) checkByUrl.set(key, check.name);
    }
  }

  const v1 = openV1(v1Path);
  try {
    const services = v1
      .prepare('SELECT id, name, internal_url AS url FROM custom_services ORDER BY name, id')
      .all() as { id: string; name: string; url: string }[];
    const known = new Set(services.map((s) => s.id));
    const orphanRows = (
      v1.prepare('SELECT service_id AS id, count(*) AS n FROM probe_history GROUP BY service_id').all() as {
        id: string;
        n: number;
      }[]
    )
      .filter((row) => !known.has(row.id))
      .reduce((sum, row) => sum + row.n, 0);

    const sqlite = handle.sqlite;
    const entityOf = sqlite.prepare<[string, string], { id: number }>(
      "SELECT id FROM entities WHERE instance_id = ? AND kind = 'Service' AND external_id = ?",
    );
    const seriesOf = sqlite.prepare<[number, string], { id: number }>(
      'SELECT id FROM metric_series WHERE entity_id = ? AND name = ?',
    );
    const insertSeries = sqlite.prepare<[number, string, string], { id: number }>(
      'INSERT INTO metric_series (entity_id, name, unit) VALUES (?, ?, ?) RETURNING id',
    );
    const firstValue = sqlite.prepare<[number, number, number], { v: number | null }>(
      `SELECT min(v) AS v FROM (
         SELECT min(ts) AS v FROM metric_raw WHERE series_id = ?
         UNION ALL SELECT min(bucket) FROM metric_5m WHERE series_id = ?
         UNION ALL SELECT min(bucket) FROM metric_1h WHERE series_id = ?)`,
    );
    const historyOf = v1.prepare<[string, number], V1Row>(
      'SELECT ts, status, response_ms FROM probe_history WHERE service_id = ? AND ts * 1000 < ? ORDER BY ts',
    );
    const insertRaw = sqlite.prepare('INSERT OR IGNORE INTO metric_raw (series_id, ts, value) VALUES (?, ?, ?)');
    const insertTier = (table: 'metric_5m' | 'metric_1h') =>
      sqlite.prepare(
        `INSERT OR IGNORE INTO ${table} (series_id, bucket, avg, min, max, count) VALUES (?, ?, ?, ?, ?, ?)`,
      );
    const insert5m = insertTier('metric_5m');
    const insert1h = insertTier('metric_1h');

    const write = (entityId: number, name: string, unit: string, values: [number, number][]) => {
      const seriesId =
        seriesOf.get(entityId, name)?.id ?? (insertSeries.get(entityId, name, unit) as { id: number }).id;
      const { raw, fiveMin, hour } = tiers(values, options.now);
      for (const [ts, value] of raw) insertRaw.run(seriesId, ts, value);
      for (const [bucket, b] of fiveMin) insert5m.run(seriesId, bucket, b.sum / b.count, b.min, b.max, b.count);
      for (const [bucket, b] of hour) insert1h.run(seriesId, bucket, b.sum / b.count, b.min, b.max, b.count);
    };

    const reports: ServiceReport[] = [];
    const run = () => {
      for (const service of services) {
        const base = { serviceId: service.id, serviceName: service.name, rows: 0, from: null, to: null };
        const check = checkByUrl.get(normaliseUrl(service.url)) ?? null;
        if (!check) {
          reports.push({ ...base, check, skipped: 'NO_CHECK' });
          continue;
        }
        const entity = entityOf.get(instance.id, check);
        if (!entity) {
          reports.push({ ...base, check, skipped: 'NOT_RUN_YET' });
          continue;
        }
        const statusSeries = seriesOf.get(entity.id, 'uptime.status')?.id;
        const cutoff =
          (statusSeries === undefined ? null : firstValue.get(statusSeries, statusSeries, statusSeries)?.v) ??
          options.now;
        const rows = historyOf.all(service.id, cutoff);
        if (rows.length === 0) {
          reports.push({ ...base, check, skipped: 'NO_OLDER_DATA' });
          continue;
        }
        const status: [number, number][] = rows.map((row) => [row.ts * 1000, row.status === 'err' ? 0 : 1]);
        const response: [number, number][] = rows
          .filter((row) => row.status !== 'err')
          .map((row) => [row.ts * 1000, row.response_ms]);
        if (!options.dryRun) {
          write(entity.id, 'uptime.status', '', status);
          write(entity.id, 'uptime.response_ms', 'ms', response);
        }
        const from = (rows[0] as V1Row).ts * 1000;
        const to = (rows.at(-1) as V1Row).ts * 1000;
        reports.push({ ...base, check, rows: rows.length, from, to });
      }
      if (!options.dryRun) {
        recordAudit(
          handle.db,
          {
            event: 'uptime.legacy_import',
            result: 'success',
            targetType: 'plugin_instance',
            targetId: instance.id,
            details: {
              via: 'cli',
              orphanRows,
              checks: reports
                .filter((r) => r.rows > 0)
                .map((r) => ({ check: r.check, rows: r.rows, from: r.from, to: r.to })),
            },
          },
          () => options.now,
        );
      }
    };
    sqlite.transaction(run)();
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      services: reports,
      orphanRows,
      dryRun: options.dryRun,
    };
  } finally {
    v1.close();
  }
}
