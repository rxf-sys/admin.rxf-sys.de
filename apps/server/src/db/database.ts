import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: Db;
}

/** Opens the SQLite file with the settings every connection needs (ADR 0004, lesson #5). */
export function openDatabase(file: string): DatabaseHandle {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
