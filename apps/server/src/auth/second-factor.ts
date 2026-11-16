import { and, eq, isNull } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { MasterKey } from '../crypto/master-key.ts';
import { openSecret, type SecretLocation, sealSecret } from '../crypto/secret-box.ts';
import type { Db } from '../db/database.ts';
import { userBackupCodes, userTotp } from '../db/schema.ts';
import { groupCode, normalizeCode, randomBase32, sha256 } from './tokens.ts';

const ISSUER = 'rxf-sys Control';
const PERIOD_S = 30;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

function totpLocation(userId: number): SecretLocation {
  return { instanceId: `user-${userId}`, slot: 'auth', field: 'totp' };
}

function totpFor(secret: string, username: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_S,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/** Starts (or restarts) enrolment: a new secret, sealed (ADR 0006) and unconfirmed until a valid code arrives. */
export function beginTotpEnrolment(db: Db, key: MasterKey, userId: number, username: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const sealed = sealSecret(key, totpLocation(userId), secret);
  const row = { ...sealed, confirmedAt: null, lastStep: null };
  db.insert(userTotp)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: userTotp.userId, set: row })
    .run();
  return { secret, uri: totpFor(secret, username).toString() };
}

/**
 * RFC 6238 check with ±1 step. A step at or before the last accepted one is refused, so an observed
 * code cannot be replayed (lesson #3). Returns the matched step or null.
 */
function matchTotp(
  secret: string,
  username: string,
  code: string,
  now: number,
  lastStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totpFor(secret, username).validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / PERIOD_S) + delta;
  return lastStep !== null && step <= lastStep ? null : step;
}

interface TotpCheck {
  db: Db;
  keys: readonly MasterKey[];
  userId: number;
  username: string;
  code: string;
  now: number;
  /** Enrolment confirms an unconfirmed secret; sign-in only accepts a confirmed one. */
  confirming: boolean;
}

export function verifyTotp(check: TotpCheck): boolean {
  const row = check.db.select().from(userTotp).where(eq(userTotp.userId, check.userId)).get();
  if (!row || (row.confirmedAt === null) !== check.confirming) return false;
  const secret = openSecret(check.keys, totpLocation(check.userId), row);
  const step = matchTotp(secret, check.username, check.code, check.now, row.lastStep);
  if (step === null) return false;
  check.db
    .update(userTotp)
    .set({ lastStep: step, confirmedAt: row.confirmedAt ?? check.now })
    .where(eq(userTotp.userId, check.userId))
    .run();
  return true;
}

/** Replaces all backup codes; the plain codes are returned once and only their hashes are stored. */
export function issueBackupCodes(db: Db, userId: number): string[] {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => randomBase32(BACKUP_CODE_LENGTH));
  db.transaction((tx) => {
    tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId)).run();
    tx.insert(userBackupCodes)
      .values(codes.map((code) => ({ userId, codeHash: sha256(code) })))
      .run();
  });
  return codes.map((code) => groupCode(code));
}

/** Uses up a matching, unused backup code. */
export function consumeBackupCode(db: Db, userId: number, input: string, now: number): boolean {
  const code = normalizeCode(input);
  if (code.length !== BACKUP_CODE_LENGTH) return false;
  const result = db
    .update(userBackupCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        eq(userBackupCodes.codeHash, sha256(code)),
        isNull(userBackupCodes.usedAt),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Emergency reset (ADR 0005): removes TOTP and backup codes; the next sign-in must enrol again. */
export function resetSecondFactor(db: Db, userId: number): void {
  db.transaction((tx) => {
    tx.delete(userTotp).where(eq(userTotp.userId, userId)).run();
    tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId)).run();
  });
}
