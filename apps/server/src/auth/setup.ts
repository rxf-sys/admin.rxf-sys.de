import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/database.ts';
import { setupState, users } from '../db/schema.ts';
import { groupCode, normalizeCode, randomBase32, safeEqual, sha256 } from './tokens.ts';

const SETUP_CODE_LENGTH = 20; // 100 bits
const SETUP_CODE_TTL_MS = 24 * 60 * 60_000;

function hasActiveAdmin(db: Db): boolean {
  return (
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .get() !== undefined
  );
}

export function isSetupOpen(db: Db): boolean {
  const state = db.select().from(setupState).where(eq(setupState.id, 1)).get();
  return !state?.completedAt && !hasActiveAdmin(db);
}

/**
 * Called at startup. While no admin exists, every start issues a fresh code (the previous one stops
 * working), stores only its hash and returns it once for the log (ADR 0005, threat T1).
 */
export function issueSetupCode(db: Db, now: number): string | null {
  if (!isSetupOpen(db)) return null;
  const code = randomBase32(SETUP_CODE_LENGTH);
  const row = { codeHash: sha256(code), expiresAt: now + SETUP_CODE_TTL_MS, completedAt: null };
  db.insert(setupState)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: setupState.id, set: row })
    .run();
  return groupCode(code);
}

export function checkSetupCode(db: Db, input: string, now: number): boolean {
  const state = db.select().from(setupState).where(eq(setupState.id, 1)).get();
  if (!state?.codeHash || !state.expiresAt || state.expiresAt <= now) return false;
  return safeEqual(sha256(normalizeCode(input)), state.codeHash);
}

export function completeSetup(db: Db, now: number): void {
  db.update(setupState).set({ codeHash: null, expiresAt: null, completedAt: now }).where(eq(setupState.id, 1)).run();
}
