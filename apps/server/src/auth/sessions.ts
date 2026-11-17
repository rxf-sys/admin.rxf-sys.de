import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/database.ts';
import { sessions, users, userTotp } from '../db/schema.ts';
import { randomToken, sha256 } from './tokens.ts';

export type Role = 'viewer' | 'operator' | 'admin';

const SESSION_COOKIE = '__Host-rxf_session';
export const IDLE_TIMEOUT_MS = 12 * 60 * 60_000;
const ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const ELEVATION_MS = 10 * 60_000;
/** last_seen_at is written at most once a minute, not on every request. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * `__Host-` requires Secure, Path=/ and no Domain. The browser keeps the cookie up to the absolute lifetime;
 * the server enforces idle and absolute expiry itself.
 */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${ABSOLUTE_LIFETIME_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Reads the session token from a Cookie header. Tokens are base64url, so no decoding is involved. */
export function readSessionToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, value] = part.trim().split('=', 2);
    if (name === SESSION_COOKIE && value && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return null;
}

export interface Session {
  tokenHash: string;
  prefix: string;
  userId: number;
  username: string;
  role: Role;
  mfaDone: boolean;
  hasTotp: boolean;
  csrfToken: string;
  elevatedUntil: number | null;
}

interface NewSession {
  userId: number;
  mfaDone: boolean;
  ip: string | null;
  userAgent: string | null;
}

/** Creates a session and returns the raw token; only its SHA-256 is stored (lesson #14). */
export function createSession(db: Db, input: NewSession, now: number): { token: string; csrfToken: string } {
  const token = randomToken();
  const tokenHash = sha256(token);
  const csrfToken = randomToken();
  db.insert(sessions)
    .values({
      tokenHash,
      prefix: tokenHash.slice(0, 8),
      userId: input.userId,
      csrfToken,
      mfaDone: input.mfaDone,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ABSOLUTE_LIFETIME_MS,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 200) ?? null,
    })
    .run();
  return { token, csrfToken };
}

/** Looks the token up; expired or idle sessions and disabled accounts resolve to null and are removed. */
export function resolveSession(db: Db, token: string, now: number): Session | null {
  const tokenHash = sha256(token);
  const row = db
    .select({ session: sessions, user: users, totpConfirmedAt: userTotp.confirmedAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(userTotp, eq(userTotp.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .get();
  if (!row) return null;
  const { session, user } = row;
  if (session.expiresAt <= now || session.lastSeenAt + IDLE_TIMEOUT_MS <= now || user.status !== 'active') {
    revokeSession(db, tokenHash);
    return null;
  }
  if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.tokenHash, tokenHash)).run();
  }
  return {
    tokenHash,
    prefix: session.prefix,
    userId: user.id,
    username: user.username,
    role: user.role,
    mfaDone: session.mfaDone,
    hasTotp: row.totpConfirmedAt !== null,
    csrfToken: session.csrfToken,
    elevatedUntil: session.elevatedUntil,
  };
}

export function revokeSession(db: Db, tokenHash: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
}

/** "Sign out everywhere": every session of the user, optionally keeping the current one. */
export function revokeUserSessions(db: Db, userId: number, keepTokenHash?: string): number {
  const where = keepTokenHash
    ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepTokenHash))
    : eq(sessions.userId, userId);
  return db.delete(sessions).where(where).run().changes;
}

export function elevateSession(db: Db, tokenHash: string, now: number): number {
  const elevatedUntil = now + ELEVATION_MS;
  db.update(sessions).set({ elevatedUntil }).where(eq(sessions.tokenHash, tokenHash)).run();
  return elevatedUntil;
}

export function listSessions(db: Db, userId: number) {
  return db
    .select({
      prefix: sessions.prefix,
      tokenHash: sessions.tokenHash,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .all();
}

export function revokeSessionByPrefix(db: Db, userId: number, prefix: string): boolean {
  return (
    db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.prefix, prefix)))
      .run().changes > 0
  );
}
