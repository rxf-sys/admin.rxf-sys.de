import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { recordAudit } from './audit.ts';
import { resetSecondFactor } from './auth/second-factor.ts';
import { revokeUserSessions } from './auth/sessions.ts';
import { readConfig } from './config.ts';
import { generateMasterKey } from './crypto/master-key.ts';
import { type DatabaseHandle, openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';
import { users } from './db/schema.ts';

const USAGE = [
  'usage: rxf keygen                     print a new master key (32 random bytes, base64) for RXF_MASTER_KEY_FILE',
  '       rxf admin reset-2fa <username>  remove the second factor of an account and sign it out everywhere',
].join('\n');

function resetTwoFactor(storage: DatabaseHandle, username: string, out: (line: string) => void): number {
  const user = storage.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
  if (!user) {
    out(`no account named "${username}"`);
    return 1;
  }
  resetSecondFactor(storage.db, user.id);
  const revoked = revokeUserSessions(storage.db, user.id);
  recordAudit(storage.db, {
    event: 'auth.mfa_reset',
    result: 'success',
    targetType: 'user',
    targetId: String(user.id),
    details: { via: 'cli', sessionsRevoked: revoked },
  });
  out(`second factor of "${username}" removed; it must be enrolled again at the next sign-in`);
  return 0;
}

/** Container-side admin commands (ADR 0005, 0006). Returns the process exit code. */
export function runCli(args: readonly string[], out: (line: string) => void, storage?: () => DatabaseHandle): number {
  const [command, sub, name] = args;
  if (command === 'keygen' && args.length === 1) {
    out(generateMasterKey());
    return 0;
  }
  if (command === 'admin' && sub === 'reset-2fa' && name && args.length === 3 && storage) {
    const handle = storage();
    try {
      return resetTwoFactor(handle, name, out);
    } finally {
      handle.sqlite.close();
    }
  }
  out(USAGE);
  return command === undefined || command === 'help' ? 0 : 2;
}

if (import.meta.main) {
  const storage = () => {
    const config = readConfig(process.env);
    const handle = openDatabase(join(config.dataDir, 'rxf-admin-v2.db'));
    migrateDatabase(handle, { backupDir: join(config.dataDir, 'backups') });
    return handle;
  };
  process.exitCode = runCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`), storage);
}
