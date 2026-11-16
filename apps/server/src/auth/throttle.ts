import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/database.ts';
import { loginAttempts } from '../db/schema.ts';

interface WindowRule {
  limit: number;
  windowMs: number;
}

/** Per client IP: 20 failed logins in 10 minutes (ADR 0005). */
export const LOGIN_IP_RULE: WindowRule = { limit: 20, windowMs: 10 * 60_000 };
/** Setup code: 5 tries per IP in 5 minutes and 20 per hour overall (ADR 0005). */
export const SETUP_IP_RULE: WindowRule = { limit: 5, windowMs: 5 * 60_000 };
export const SETUP_GLOBAL_RULE: WindowRule = { limit: 20, windowMs: 60 * 60_000 };

const ACCOUNT_FREE_FAILURES = 5;
const ACCOUNT_FIRST_LOCK_MS = 30_000;
const ACCOUNT_MAX_LOCK_MS = 15 * 60_000;

/**
 * Failure counters in `login_attempts`. Accounts get an exponential backoff that never becomes permanent
 * (a permanent lock would let anyone lock out the admin); IP and setup keys use fixed windows.
 */
export class Throttle {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  #row(key: string) {
    return this.#db.select().from(loginAttempts).where(eq(loginAttempts.key, key)).get();
  }

  #save(key: string, failures: number, windowStart: number, lockedUntil: number | null): void {
    const updatedAt = this.#now();
    this.#db
      .insert(loginAttempts)
      .values({ key, failures, windowStart, lockedUntil, updatedAt })
      .onConflictDoUpdate({ target: loginAttempts.key, set: { failures, windowStart, lockedUntil, updatedAt } })
      .run();
  }

  /** Milliseconds until the window frees up; 0 when the next attempt may go ahead. */
  windowWait(key: string, rule: WindowRule): number {
    const row = this.#row(key);
    if (!row || row.failures < rule.limit) return 0;
    return Math.max(0, row.windowStart + rule.windowMs - this.#now());
  }

  recordWindowFailure(key: string, rule: WindowRule): void {
    const now = this.#now();
    const row = this.#row(key);
    if (!row || now - row.windowStart >= rule.windowMs) this.#save(key, 1, now, null);
    else this.#save(key, row.failures + 1, row.windowStart, null);
  }

  /** Milliseconds the account still has to wait. */
  accountWait(key: string): number {
    const lockedUntil = this.#row(key)?.lockedUntil;
    return lockedUntil ? Math.max(0, lockedUntil - this.#now()) : 0;
  }

  recordAccountFailure(key: string): void {
    const now = this.#now();
    const failures = (this.#row(key)?.failures ?? 0) + 1;
    const over = failures - ACCOUNT_FREE_FAILURES;
    const lockedUntil = over >= 0 ? now + Math.min(ACCOUNT_FIRST_LOCK_MS * 2 ** over, ACCOUNT_MAX_LOCK_MS) : null;
    this.#save(key, failures, now, lockedUntil);
  }

  clear(key: string): void {
    this.#db.delete(loginAttempts).where(eq(loginAttempts.key, key)).run();
  }

  /** Drops counters untouched for a day whose lock has run out (lesson #7: the table stays bounded). */
  prune(maxAgeMs = 24 * 60 * 60_000): void {
    const now = this.#now();
    this.#db
      .delete(loginAttempts)
      .where(
        and(
          lt(loginAttempts.updatedAt, now - maxAgeMs),
          or(isNull(loginAttempts.lockedUntil), lt(loginAttempts.lockedUntil, now)),
        ),
      )
      .run();
  }
}
