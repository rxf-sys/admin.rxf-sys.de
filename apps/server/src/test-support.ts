import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from './app.ts';
import { generateMasterKey, type MasterKey, parseMasterKey } from './crypto/master-key.ts';
import { type DatabaseHandle, openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';

/** In-memory database with all migrations applied, for tests. */
export function testDatabase(): DatabaseHandle {
  const handle = openDatabase(':memory:');
  migrateDatabase(handle, { backupDir: null });
  return handle;
}

export function testMasterKey(): MasterKey {
  return parseMasterKey(generateMasterKey(), 'test');
}

/** A small list instead of the real 10k file keeps tests independent of the asset. */
const TEST_COMMON_PASSWORDS: ReadonlySet<string> = new Set(['password', 'letmein', 'qwertyuiop']);

export interface TestApp {
  app: FastifyInstance;
  database: DatabaseHandle;
  masterKey: MasterKey;
  clock: { now: number };
}

/** App on an in-memory database with a controllable clock. */
export function testApp(start = Date.UTC(2026, 10, 16, 12)): TestApp {
  const database = testDatabase();
  const masterKey = testMasterKey();
  const clock = { now: start };
  const app = buildApp({
    version: '2.0.0-test',
    database,
    masterKey,
    commonPasswords: TEST_COMMON_PASSWORDS,
    now: () => clock.now,
  });
  return { app, database, masterKey, clock };
}

/** Returns the session token from a Set-Cookie header, or null. */
export function sessionTokenFrom(res: LightMyRequestResponse): string | null {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.match(/^__Host-rxf_session=([A-Za-z0-9_-]{43});/)?.[1] ?? null;
}
