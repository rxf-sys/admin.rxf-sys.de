import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.ts';
import { MIGRATIONS_DIR, migrateDatabase } from './migrate.ts';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rxf-db-'));
}

function tables(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}

/** Copy of the real migrations up to and including `tag`, to build a database in an older state. */
function migrationsUpTo(tag: string): string {
  const dir = tempDir();
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalFile = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  const end = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalFile, JSON.stringify(journal));
  return dir;
}

/** Copy of the real migrations plus one extra step, to exercise the upgrade path of an existing database. */
function migrationsWithExtraStep(): string {
  const dir = tempDir();
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalFile = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  const last = journal.entries.at(-1);
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1,
    tag: '9999_test_step',
    breakpoints: true,
  });
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(join(dir, '9999_test_step.sql'), 'CREATE TABLE `test_step` (`id` integer PRIMARY KEY);');
  return dir;
}

describe('database', () => {
  it('opens with WAL and foreign keys on', () => {
    const dir = tempDir();
    const { sqlite } = openDatabase(join(dir, 'nested', 'rxf-admin-v2.db'));
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    sqlite.close();
  });
});

describe('migrateDatabase', () => {
  it('creates the schema on a fresh database without a backup', () => {
    const dir = tempDir();
    const handle = openDatabase(join(dir, 'rxf-admin-v2.db'));
    const result = migrateDatabase(handle, { backupDir: join(dir, 'backups') });
    expect(result).toEqual({
      applied: ['0000_audit_events', '0001_auth', '0002_plugins', '0003_metrics'],
      backupFile: null,
    });
    expect(tables(handle.sqlite)).toEqual([
      '__drizzle_migrations',
      'audit_events',
      'entities',
      'login_attempts',
      'metric_1h',
      'metric_5m',
      'metric_raw',
      'metric_series',
      'plugin_instances',
      'secrets',
      'sessions',
      'setup_state',
      'user_backup_codes',
      'user_passwords',
      'user_totp',
      'users',
    ]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    handle.sqlite.close();
  });

  it('does nothing when the schema is current', () => {
    const dir = tempDir();
    const handle = openDatabase(join(dir, 'rxf-admin-v2.db'));
    migrateDatabase(handle, { backupDir: join(dir, 'backups') });
    expect(migrateDatabase(handle, { backupDir: join(dir, 'backups') })).toEqual({ applied: [], backupFile: null });
    handle.sqlite.close();
  });

  it('backs up an existing database before upgrading it', () => {
    const dir = tempDir();
    const handle = openDatabase(join(dir, 'rxf-admin-v2.db'));
    migrateDatabase(handle, { backupDir: join(dir, 'backups') });
    handle.sqlite.prepare("INSERT INTO audit_events (ts, event, result) VALUES (1, 'auth.login', 'success')").run();

    const result = migrateDatabase(handle, {
      migrationsDir: migrationsWithExtraStep(),
      backupDir: join(dir, 'backups'),
    });
    expect(result.applied).toEqual(['9999_test_step']);
    expect(result.backupFile).toMatch(/backups\/pre-migration-9999_test_step-\d+\.db$/);
    expect(tables(handle.sqlite)).toContain('test_step');

    const backup = new Database(result.backupFile as string, { readonly: true });
    expect(tables(backup)).not.toContain('test_step');
    expect(backup.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
    backup.close();
    handle.sqlite.close();
  });

  it('upgrades a 0002 database with instances to the metrics schema (0003)', () => {
    const dir = tempDir();
    const handle = openDatabase(join(dir, 'rxf-admin-v2.db'));
    migrateDatabase(handle, { migrationsDir: migrationsUpTo('0002_plugins'), backupDir: null });
    handle.sqlite
      .prepare(
        "INSERT INTO plugin_instances (id, plugin_id, name, status, config_json, created_at, updated_at) VALUES ('i1', 'uptime', 'U', 'active', '{}', 1, 1)",
      )
      .run();

    expect(migrateDatabase(handle, { backupDir: join(dir, 'backups') }).applied).toEqual(['0003_metrics']);
    const sql = (name: string) =>
      (handle.sqlite.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql;
    for (const table of ['metric_raw', 'metric_5m', 'metric_1h']) expect(sql(table)).toMatch(/WITHOUT ROWID$/);

    // Deleting the instance removes its entities, series and values through the foreign keys.
    const run = (statement: string) => handle.sqlite.prepare(statement).run();
    run(
      "INSERT INTO entities (instance_id, collector_id, kind, external_id, name, status, updated_at) VALUES ('i1', 'http', 'Service', 'a', 'A', 'ok', 1)",
    );
    run("INSERT INTO metric_series (entity_id, name, unit) VALUES (1, 'uptime.response_ms', 'ms')");
    run('INSERT INTO metric_raw (series_id, ts, value) VALUES (1, 1, 12.5)');
    run('INSERT INTO metric_5m (series_id, bucket, avg, min, max, count) VALUES (1, 0, 1, 1, 1, 1)');
    run("DELETE FROM plugin_instances WHERE id = 'i1'");
    for (const table of ['entities', 'metric_series', 'metric_raw', 'metric_5m']) {
      expect(handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    handle.sqlite.close();
  });
});
