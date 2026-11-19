import { join } from 'node:path';
import { buildApp } from './app.ts';
import { issueSetupCode } from './auth/setup.ts';
import { readConfig } from './config.ts';
import { loadMasterKey } from './crypto/master-key.ts';
import { backupDaily } from './db/backup.ts';
import { openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';
import { loggerOptions } from './log/logger.ts';

const config = readConfig(process.env);
// Without the key no secret can be read or written, so the server refuses to start (ADR 0006).
const masterKey = await loadMasterKey({ file: config.masterKeyFile, inline: config.masterKeyInline });
const database = openDatabase(join(config.dataDir, 'rxf-admin-v2.db'));
const migration = migrateDatabase(database, { backupDir: join(config.dataDir, 'backups') });

const app = buildApp({
  version: config.version,
  database,
  masterKey,
  trustedProxies: config.trustedProxies,
  publicOrigin: config.publicOrigin,
  logger: loggerOptions(),
});
app.log.info({ keyId: masterKey.id, migrations: migration.applied, backup: migration.backupFile }, 'storage ready');

// The setup code only ever appears here, in the log of the starting container (ADR 0005, T1).
const setupCode = issueSetupCode(database.db, Date.now());
if (setupCode) app.log.warn(`No admin yet. Setup code (valid 24 h, replaced on restart): ${setupCode}`);

// Daily copy in /data/backups (ADR 0009); checked hourly, written once per day.
const backups = () => {
  try {
    const result = backupDaily(database, join(config.dataDir, 'backups'), Date.now());
    if (result.written || result.removed.length > 0) app.log.info(result, 'daily backup');
  } catch (error) {
    app.log.error({ err: error }, 'daily backup failed');
  }
};
backups();
const backupTimer = setInterval(backups, 60 * 60_000);
backupTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(backupTimer);
    void app.close().then(() => database.sqlite.close());
  });
}

await app.listen({ host: config.host, port: config.port });
