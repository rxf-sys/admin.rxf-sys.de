import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { recordAudit } from './audit.ts';
import { resetSecondFactor } from './auth/second-factor.ts';
import { revokeUserSessions } from './auth/sessions.ts';
import { readConfig } from './config.ts';
import { generateMasterKey } from './crypto/master-key.ts';
import { importV1Uptime, LegacyImportError, type LegacyImportReport } from './data/legacy-import.ts';
import { type DatabaseHandle, openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';
import { users } from './db/schema.ts';

const USAGE = [
  'usage: rxf keygen                     print a new master key (32 random bytes, base64) for RXF_MASTER_KEY_FILE',
  '       rxf admin reset-2fa <username>  remove the second factor of an account and sign it out everywhere',
  '       rxf import v1-uptime <v1.db> [--instance <id>] [--dry-run]',
  '                                       take the v1 probe history over onto the matching uptime checks',
].join('\n');

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const SKIPPED: Record<string, string> = {
  NO_CHECK: 'no v2 HTTP check with this URL',
  NOT_RUN_YET: 'the check has not run yet; activate the instance and wait for its first run',
  NO_OLDER_DATA: 'nothing older than the first v2 value',
};

function printReport(report: LegacyImportReport, out: (line: string) => void): void {
  out(
    `${report.dryRun ? 'dry run, nothing written: ' : ''}uptime instance "${report.instanceName}" (${report.instanceId})`,
  );
  for (const s of report.services) {
    const label = `${s.serviceName} (${s.serviceId})`;
    if (s.skipped) {
      out(`  skipped ${label}: ${SKIPPED[s.skipped]}`);
    } else {
      out(`  ${label} → "${s.check}": ${s.rows} values, ${day(s.from as number)} to ${day(s.to as number)}`);
    }
  }
  if (report.orphanRows > 0) out(`  dropped ${report.orphanRows} values of services that v1 no longer knows`);
}

function importLegacy(storage: DatabaseHandle, rest: readonly string[], out: (line: string) => void): number {
  const [path, ...flags] = rest;
  let instanceId: string | undefined;
  let dryRun = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--dry-run') dryRun = true;
    else if (flags[i] === '--instance' && flags[i + 1]) instanceId = flags[++i];
    else {
      out(USAGE);
      return 2;
    }
  }
  if (!path) {
    out(USAGE);
    return 2;
  }
  try {
    printReport(importV1Uptime(storage, path, { instanceId, dryRun, now: Date.now() }), out);
    return 0;
  } catch (error) {
    if (!(error instanceof LegacyImportError)) throw error;
    out(error.message);
    return 1;
  }
}

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
  if (command === 'import' && sub === 'v1-uptime' && storage) {
    const handle = storage();
    try {
      return importLegacy(handle, args.slice(2), out);
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
