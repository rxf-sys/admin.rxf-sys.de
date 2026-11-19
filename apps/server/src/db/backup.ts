import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseHandle } from './database.ts';

const DAY = 24 * 60 * 60_000;
const DAILY = /^daily-(\d{4}-\d{2}-\d{2})\.db$/;

/**
 * Daily copy of the database via `VACUUM INTO` (ADR 0009), kept 14 days, in addition to the vzdump of the
 * LXC. Writes at most one file per UTC day; returns the file written, or null when today's exists.
 */
export function backupDaily(
  handle: DatabaseHandle,
  dir: string,
  now: number,
  keepDays = 14,
): { written: string | null; removed: string[] } {
  mkdirSync(dir, { recursive: true });
  const today = new Date(now).toISOString().slice(0, 10);
  const target = join(dir, `daily-${today}.db`);
  let written: string | null = null;
  if (!existsSync(target)) {
    // Written under a temporary name and renamed, so an interrupted run never counts as today's backup.
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    handle.sqlite.prepare('VACUUM INTO ?').run(partial);
    renameSync(partial, target);
    written = target;
  }
  const oldest = new Date(now - keepDays * DAY).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const file of readdirSync(dir)) {
    const day = DAILY.exec(file)?.[1];
    if (day && day < oldest) {
      unlinkSync(join(dir, file));
      removed.push(file);
    }
  }
  return { written, removed };
}
