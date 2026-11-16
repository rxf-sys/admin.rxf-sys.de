import { join } from 'node:path';
import { buildApp } from './app.ts';
import { readConfig } from './config.ts';
import { loadMasterKey } from './crypto/master-key.ts';
import { openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';
import { loggerOptions } from './log/logger.ts';

const config = readConfig(process.env);
// Without the key no secret can be read or written, so the server refuses to start (ADR 0006).
const masterKey = await loadMasterKey({ file: config.masterKeyFile, inline: config.masterKeyInline });
const database = openDatabase(join(config.dataDir, 'rxf-admin-v2.db'));
const migration = migrateDatabase(database, { backupDir: join(config.dataDir, 'backups') });

const app = buildApp({ version: config.version, database, logger: loggerOptions() });
app.log.info({ keyId: masterKey.id, migrations: migration.applied, backup: migration.backupFile }, 'storage ready');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => database.sqlite.close());
  });
}

await app.listen({ host: config.host, port: config.port });
