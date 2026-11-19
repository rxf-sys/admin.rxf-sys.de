import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.ts';
import type { DatabaseHandle } from '../db/database.ts';
import { testDatabase } from '../test-support.ts';
import { EntityStore } from './entities.ts';
import { importV1Uptime, LegacyImportError } from './legacy-import.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 19, 12);
/** The first v2 value of the "Website" check, one hour before NOW. */
const FIRST_V2 = NOW - HOUR;
const INSTANCE = '11111111-1111-1111-1111-111111111111';

/** The v1 DDL verbatim (docs/integrations/uptime.md, backend/app/storage.py and registry.py). */
const V1_DDL = `
CREATE TABLE IF NOT EXISTS probe_history (
    ts         INTEGER NOT NULL,
    service_id TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    response_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS service_incidents (
    service_id  TEXT    NOT NULL,
    started_ts  INTEGER NOT NULL,
    ended_ts    INTEGER,
    worst_status TEXT   NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_services (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'cloud',
    descr TEXT NOT NULL DEFAULT '', internal_url TEXT NOT NULL, ext_url TEXT,
    created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE accounts (username TEXT, totp_secret TEXT);
`;

let dir: string;
let v1Path: string;
let handle: DatabaseHandle;
let entities: EntityStore;

function v1Database(rows: [tsMs: number, service: string, status: string, ms: number][]) {
  const v1 = new Database(v1Path);
  v1.exec(V1_DDL);
  const service = v1.prepare(
    'INSERT INTO custom_services (id, name, internal_url, ext_url, created_at) VALUES (?, ?, ?, ?, 0)',
  );
  service.run('cloud', 'Nextcloud', 'http://cloud.lan', 'https://cloud.rxf-sys.de');
  service.run('web', 'Website', 'https://rxf-sys.de/', null);
  service.run('custom-1a2b3c4d', 'Old NAS', 'http://nas.lan:5000/', null);
  const insert = v1.prepare('INSERT INTO probe_history (ts, service_id, status, response_ms) VALUES (?, ?, ?, ?)');
  v1.transaction(() => {
    for (const [ts, id, status, ms] of rows) insert.run(Math.floor(ts / 1000), id, status, ms);
  })();
  v1.prepare("INSERT INTO accounts VALUES ('robin', 'SECRET')").run();
  v1.close();
}

function addInstance(id: string, name: string, checks: unknown[]) {
  handle.sqlite
    .prepare(
      "INSERT INTO plugin_instances (id, plugin_id, name, status, config_json, created_at, updated_at) VALUES (?, 'uptime', ?, 'active', ?, 0, 0)",
    )
    .run(id, name, JSON.stringify({ checks, slowThresholdMs: 800, allowBlockedTargets: false }));
}

/** The check has run once in v2: entity plus a first status value. */
function ranInV2(name: string, ts = FIRST_V2) {
  entities.applySnapshot(
    INSTANCE,
    'checks',
    {
      entities: [{ kind: 'Service', externalId: name, name, status: 'ok' }],
      metrics: [{ entity: { kind: 'Service', externalId: name }, name: 'uptime.status', unit: '', value: 1, ts }],
    },
    ts,
    { graceMs: MIN },
  );
}

const count = (sql: string, ...params: unknown[]) => (handle.sqlite.prepare(sql).get(...params) as { n: number }).n;

function seriesId(check: string, name: string): number {
  return (
    handle.sqlite
      .prepare(
        'SELECT s.id FROM metric_series s JOIN entities e ON e.id = s.entity_id WHERE e.external_id = ? AND s.name = ?',
      )
      .get(check, name) as { id: number }
  ).id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rxf-v1-'));
  v1Path = join(dir, 'rxf-admin.db');
  handle = testDatabase();
  entities = new EntityStore(handle);
  addInstance(INSTANCE, 'Uptime', [
    { name: 'Website', url: 'https://rxf-sys.de' },
    { name: 'Cloud', url: 'http://cloud.lan/' },
    { type: 'tcp', name: 'SSH', host: 'nas.lan', port: 22 },
  ]);
});

afterEach(() => {
  handle.sqlite.close();
});

describe('importV1Uptime', () => {
  it('takes older v1 values over onto the check with the same internal URL, in every tier', () => {
    const rows: [number, string, string, number][] = [];
    // Five days of 30 s probes before the first v2 value, some failing, plus values v2 already covers.
    for (let ts = FIRST_V2 - 5 * DAY; ts < FIRST_V2 + 30 * MIN; ts += 30_000) {
      const status = ts % (10 * MIN) === 0 ? 'err' : ts % (7 * MIN) === 0 ? 'warn' : 'ok';
      rows.push([ts, 'web', status, status === 'err' ? 4000 : 100]);
    }
    rows.push([FIRST_V2 - DAY, 'custom-deadbeef', 'ok', 1], [FIRST_V2 - DAY, 'custom-deadbeef', 'ok', 1]);
    v1Database(rows);
    ranInV2('Website');

    const report = importV1Uptime(handle, v1Path, { dryRun: false, now: NOW });
    const web = report.services.find((s) => s.serviceId === 'web');
    const imported = rows.filter(([ts, id]) => id === 'web' && ts < FIRST_V2);
    expect(web).toMatchObject({ check: 'Website', rows: imported.length, from: FIRST_V2 - 5 * DAY });
    expect(web?.to).toBeLessThan(FIRST_V2);
    expect(report.orphanRows).toBe(2);
    expect(report.services.find((s) => s.serviceId === 'cloud')).toMatchObject({
      check: 'Cloud',
      skipped: 'NOT_RUN_YET',
    });
    expect(report.services.find((s) => s.serviceId === 'custom-1a2b3c4d')).toMatchObject({ skipped: 'NO_CHECK' });

    const status = seriesId('Website', 'uptime.status');
    // Raw: only the last two days plus the one v2 value; v2's value stays untouched.
    expect(count('SELECT min(ts) AS n FROM metric_raw WHERE series_id = ?', status)).toBeGreaterThanOrEqual(
      NOW - 2 * DAY,
    );
    expect(
      (
        handle.sqlite.prepare('SELECT value FROM metric_raw WHERE series_id = ? AND ts = ?').get(status, FIRST_V2) as {
          value: number;
        }
      ).value,
    ).toBe(1);
    // Hourly buckets hold the uptime share: 120 probes per hour, failures every 10 min count as 0.
    const hour = handle.sqlite
      .prepare('SELECT avg, count FROM metric_1h WHERE series_id = ? AND bucket = ?')
      .get(status, FIRST_V2 - 3 * DAY) as { avg: number; count: number };
    expect(hour.count).toBe(120);
    expect(hour.avg).toBeCloseTo(114 / 120, 5);
    expect(count('SELECT count(*) AS n FROM metric_5m WHERE series_id = ?', status)).toBe(5 * 24 * 12);
    // Response times only for probes that answered.
    const response = seriesId('Website', 'uptime.response_ms');
    expect(count('SELECT max(max) AS n FROM metric_5m WHERE series_id = ?', response)).toBe(100);

    const audit = handle.sqlite
      .prepare("SELECT details_json AS d FROM audit_events WHERE event = 'uptime.legacy_import'")
      .get() as {
      d: string;
    };
    expect(JSON.parse(audit.d)).toMatchObject({ orphanRows: 2, checks: [{ check: 'Website', rows: imported.length }] });

    // A second run finds nothing older than the first stored value.
    const again = importV1Uptime(handle, v1Path, { dryRun: false, now: NOW });
    expect(again.services.find((s) => s.serviceId === 'web')).toMatchObject({ skipped: 'NO_OLDER_DATA' });
  });

  it('writes nothing in a dry run', () => {
    v1Database([[FIRST_V2 - HOUR, 'web', 'ok', 50]]);
    ranInV2('Website');
    const report = importV1Uptime(handle, v1Path, { dryRun: true, now: NOW });
    expect(report.services.find((s) => s.serviceId === 'web')?.rows).toBe(1);
    expect(count('SELECT count(*) AS n FROM metric_raw')).toBe(1);
    expect(count("SELECT count(*) AS n FROM audit_events WHERE event = 'uptime.legacy_import'")).toBe(0);
  });

  it('chooses the instance and refuses files that are not v1 databases', () => {
    v1Database([]);
    expect(() => importV1Uptime(handle, v1Path, { instanceId: 'nope', dryRun: true, now: NOW })).toThrow(
      'no uptime instance nope',
    );
    addInstance('22222222-2222-2222-2222-222222222222', 'Second', []);
    expect(() => importV1Uptime(handle, v1Path, { dryRun: true, now: NOW })).toThrow(/several uptime instances/);
    expect(importV1Uptime(handle, v1Path, { instanceId: INSTANCE, dryRun: true, now: NOW }).instanceName).toBe(
      'Uptime',
    );

    const other = join(dir, 'other.db');
    new Database(other).exec('CREATE TABLE x (y)');
    expect(() => importV1Uptime(handle, other, { instanceId: INSTANCE, dryRun: true, now: NOW })).toThrow(
      LegacyImportError,
    );
    expect(() =>
      importV1Uptime(handle, join(dir, 'missing.db'), { instanceId: INSTANCE, dryRun: true, now: NOW }),
    ).toThrow(/cannot open/);
    writeFileSync(join(dir, 'junk.db'), 'not sqlite');
    expect(() =>
      importV1Uptime(handle, join(dir, 'junk.db'), { instanceId: INSTANCE, dryRun: true, now: NOW }),
    ).toThrow(LegacyImportError);
  });

  it('needs an uptime instance', () => {
    handle.sqlite.prepare('DELETE FROM plugin_instances').run();
    v1Database([]);
    expect(() => importV1Uptime(handle, v1Path, { dryRun: true, now: NOW })).toThrow('there is no uptime instance yet');
  });
});

describe('rxf import v1-uptime', () => {
  function cli(args: string[]) {
    const lines: string[] = [];
    const reusable = { ...handle, sqlite: Object.assign(Object.create(handle.sqlite), { close() {} }) };
    const code = runCli(
      args,
      (line) => lines.push(line),
      () => reusable as DatabaseHandle,
    );
    return { code, lines };
  }

  it('prints what it took over and what it skipped', () => {
    v1Database([
      [FIRST_V2 - 2 * HOUR, 'web', 'ok', 50],
      [FIRST_V2 - DAY, 'gone', 'ok', 1],
    ]);
    ranInV2('Website');
    const { code, lines } = cli(['import', 'v1-uptime', v1Path, '--instance', INSTANCE, '--dry-run']);
    expect(code).toBe(0);
    expect(lines[0]).toBe(`dry run, nothing written: uptime instance "Uptime" (${INSTANCE})`);
    expect(lines).toContain('  Website (web) → "Website": 1 values, 2026-11-19 to 2026-11-19');
    expect(lines).toContain('  skipped Old NAS (custom-1a2b3c4d): no v2 HTTP check with this URL');
    expect(lines.some((line) => line.includes('Nextcloud (cloud): the check has not run yet'))).toBe(true);
    expect(lines.at(-1)).toBe('  dropped 1 values of services that v1 no longer knows');
  });

  it('reports errors and bad arguments', () => {
    expect(cli(['import', 'v1-uptime', join(dir, 'missing.db')])).toMatchObject({
      code: 1,
      lines: [expect.stringMatching(/cannot open/)],
    });
    expect(cli(['import', 'v1-uptime']).code).toBe(2);
    expect(cli(['import', 'v1-uptime', v1Path, '--force']).code).toBe(2);
    expect(cli(['import', 'v1-uptime', v1Path, '--instance']).code).toBe(2);
  });
});
