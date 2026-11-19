import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { testDatabase } from '../test-support.ts';
import { backupDaily } from './backup.ts';

const DAY = 24 * 60 * 60_000;

describe('backupDaily', () => {
  it('writes one consistent copy per day and keeps 14 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rxf-backup-'));
    const handle = testDatabase();
    handle.sqlite.prepare("INSERT INTO audit_events (ts, event, result) VALUES (1, 'auth.login', 'success')").run();
    const now = Date.UTC(2026, 10, 19, 3);
    writeFileSync(join(dir, 'daily-2026-11-04.db'), '');
    writeFileSync(join(dir, 'daily-2026-11-05.db'), '');
    writeFileSync(join(dir, 'pre-migration-0003_metrics-1.db'), '');

    const first = backupDaily(handle, dir, now);
    expect(first).toEqual({ written: join(dir, 'daily-2026-11-19.db'), removed: ['daily-2026-11-04.db'] });
    expect(backupDaily(handle, dir, now + 60_000).written).toBeNull();
    expect(readdirSync(dir).sort()).toEqual([
      'daily-2026-11-05.db',
      'daily-2026-11-19.db',
      'pre-migration-0003_metrics-1.db',
    ]);

    const copy = new Database(first.written as string, { readonly: true });
    expect(copy.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
    copy.close();
    expect(backupDaily(handle, dir, now + DAY).written).toBe(join(dir, 'daily-2026-11-20.db'));
    handle.sqlite.close();
  });
});
