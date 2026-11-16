import { type DatabaseHandle, openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';

/** In-memory database with all migrations applied, for tests. */
export function testDatabase(): DatabaseHandle {
  const handle = openDatabase(':memory:');
  migrateDatabase(handle, { backupDir: null });
  return handle;
}
