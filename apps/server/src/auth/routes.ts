import {
  backupCodesResponse,
  codeRequest,
  loginRequest,
  loginResponse,
  reauthRequest,
  reauthResponse,
  sessionListResponse,
  sessionResponse,
  setupRequest,
  totpEnrolmentResponse,
} from '@rxf/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod/mini';
import { recordAudit } from '../audit.ts';
import type { MasterKey } from '../crypto/master-key.ts';
import type { Db } from '../db/database.ts';
import { userPasswords, users, userTotp } from '../db/schema.ts';
import { AppError } from '../http/errors.ts';
import { checkPassword, hashPassword, verifyPassword } from './passwords.ts';
import { beginTotpEnrolment, consumeBackupCode, issueBackupCodes, verifyTotp } from './second-factor.ts';
import {
  clearedSessionCookie,
  createSession,
  elevateSession,
  listSessions,
  revokeSession,
  revokeSessionByPrefix,
  revokeUserSessions,
  type Session,
  sessionCookie,
} from './sessions.ts';
import { checkSetupCode, completeSetup, isSetupOpen } from './setup.ts';
import { LOGIN_IP_RULE, SETUP_GLOBAL_RULE, SETUP_IP_RULE, Throttle } from './throttle.ts';

export interface AuthDeps {
  db: Db;
  masterKey: MasterKey;
  commonPasswords: ReadonlySet<string>;
  now: () => number;
}

const ok = z.object({ ok: z.literal(true) });

function tooManyAttempts(waitMs: number): AppError {
  const retryAfterSeconds = Math.ceil(waitMs / 1000);
  return new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts, try again later', { retryAfterSeconds });
}

function requireSession(request: FastifyRequest): Session {
  // The route guard has already rejected requests without a session on these routes.
  if (!request.session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  return request.session;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, masterKey, commonPasswords, now } = deps;
  const throttle = new Throttle(db, now);
  const keys = [masterKey];
  const api = app.withTypeProvider<ZodTypeProvider>();

  const accountKey = (name: string) => `account:${name.toLowerCase()}`;
  const audit = (request: FastifyRequest, entry: Parameters<typeof recordAudit>[1]) =>
    recordAudit(db, { actorIp: request.ip, actorUserId: request.session?.userId ?? null, ...entry }, now);

  /** New session cookie; the previous session of this browser, if any, is revoked (rotation, lesson #2). */
  function startSession(request: FastifyRequest, reply: FastifyReply, userId: number, mfaDone: boolean): void {
    if (request.session) revokeSession(db, request.session.tokenHash);
    const { token } = createSession(
      db,
      { userId, mfaDone, ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
      now(),
    );
    void reply.header('set-cookie', sessionCookie(token));
  }

  function assertPasswordPolicy(password: string): void {
    const problem = checkPassword(password, commonPasswords);
    if (problem) throw new AppError(400, 'WEAK_PASSWORD', 'The password does not meet the policy', { problem });
  }

  /** Second factor: a TOTP code, or else one unused backup code. Failures count towards the account backoff. */
  function checkSecondFactor(session: Session, code: string): boolean {
    const key = accountKey(session.username);
    const wait = throttle.accountWait(key);
    if (wait > 0) throw tooManyAttempts(wait);
    const t = now();
    const passed =
      verifyTotp({ db, keys, userId: session.userId, username: session.username, code, now: t, confirming: false }) ||
      consumeBackupCode(db, session.userId, code, t);
    if (passed) throttle.clear(key);
    else throttle.recordAccountFailure(key);
    return passed;
  }

  api.get(
    '/api/auth/session',
    { config: { auth: { role: 'public' } }, schema: { response: { 200: sessionResponse } } },
    async (request) => {
      const session = request.session;
      if (!session) return { authenticated: false as const, setupOpen: isSetupOpen(db) };
      return {
        authenticated: true as const,
        user: { id: session.userId, username: session.username, role: session.role },
        mfa: session.mfaDone ? ('done' as const) : session.hasTotp ? ('pending' as const) : ('setup_required' as const),
        csrfToken: session.csrfToken,
        elevatedUntil: session.elevatedUntil,
      };
    },
  );

  api.post(
    '/api/setup',
    { config: { auth: { role: 'public' } }, schema: { body: setupRequest, response: { 201: ok } } },
    async (request, reply) => {
      // Once the first admin exists the endpoint is gone for good (ADR 0005).
      if (!isSetupOpen(db)) throw new AppError(404, 'NOT_FOUND', 'POST /api/setup does not exist');
      const ipKey = `setup-ip:${request.ip}`;
      const wait = Math.max(
        throttle.windowWait(ipKey, SETUP_IP_RULE),
        throttle.windowWait('setup-global', SETUP_GLOBAL_RULE),
      );
      if (wait > 0) throw tooManyAttempts(wait);
      if (!checkSetupCode(db, request.body.code, now())) {
        throttle.recordWindowFailure(ipKey, SETUP_IP_RULE);
        throttle.recordWindowFailure('setup-global', SETUP_GLOBAL_RULE);
        audit(request, { event: 'setup.failed', result: 'failure' });
        throw new AppError(401, 'INVALID_SETUP_CODE', 'The setup code is wrong or has expired');
      }
      assertPasswordPolicy(request.body.password);
      const hash = await hashPassword(request.body.password);
      const t = now();
      const userId = db.transaction((tx) => {
        const user = tx
          .insert(users)
          .values({ username: request.body.username, role: 'admin', createdAt: t })
          .returning({ id: users.id })
          .get();
        tx.insert(userPasswords).values({ userId: user.id, hash, updatedAt: t }).run();
        return user.id;
      });
      completeSetup(db, t);
      throttle.clear(ipKey);
      audit(request, {
        event: 'setup.completed',
        result: 'success',
        actorUserId: userId,
        targetType: 'user',
        targetId: String(userId),
      });
      startSession(request, reply, userId, false);
      return reply.code(201).send({ ok: true as const });
    },
  );

  api.post(
    '/api/auth/login',
    { config: { auth: { role: 'public' } }, schema: { body: loginRequest, response: { 200: loginResponse } } },
    async (request, reply) => {
      const { username, password } = request.body;
      const ipKey = `ip:${request.ip}`;
      const ipWait = throttle.windowWait(ipKey, LOGIN_IP_RULE);
      if (ipWait > 0) throw tooManyAttempts(ipWait);
      // Keyed by the submitted name, existing or not, so the lock reveals nothing about which accounts exist.
      const key = accountKey(username);
      const accountWait = throttle.accountWait(key);
      if (accountWait > 0) throw tooManyAttempts(accountWait);

      const row = db
        .select({ user: users, hash: userPasswords.hash })
        .from(users)
        .leftJoin(userPasswords, eq(userPasswords.userId, users.id))
        .where(eq(users.username, username))
        .get();
      const active = row?.user.status === 'active' ? row : undefined;
      const valid = await verifyPassword(active?.hash ?? null, password);
      if (!active || !valid) {
        throttle.recordAccountFailure(key);
        throttle.recordWindowFailure(ipKey, LOGIN_IP_RULE);
        audit(request, { event: 'auth.login', result: 'failure', details: { username } });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is wrong');
      }
      throttle.clear(key);
      startSession(request, reply, active.user.id, false);
      audit(request, { event: 'auth.login', result: 'success', actorUserId: active.user.id });
      return { mfa: totpEnrolled(active.user.id) ? ('pending' as const) : ('setup_required' as const) };
    },
  );

  function totpEnrolled(userId: number): boolean {
    const row = db
      .select({ confirmedAt: userTotp.confirmedAt })
      .from(userTotp)
      .where(eq(userTotp.userId, userId))
      .get();
    return row?.confirmedAt != null;
  }

  api.post(
    '/api/auth/2fa',
    { config: { auth: { role: 'viewer', mfa: 'optional' } }, schema: { body: codeRequest, response: { 200: ok } } },
    async (request, reply) => {
      const session = requireSession(request);
      if (session.mfaDone) throw new AppError(409, 'MFA_ALREADY_DONE', 'The second factor is already done');
      if (!session.hasTotp) throw new AppError(409, 'MFA_SETUP_REQUIRED', 'Enrol a second factor first');
      if (!checkSecondFactor(session, request.body.code)) {
        audit(request, { event: 'auth.mfa', result: 'failure' });
        throw new AppError(401, 'INVALID_CODE', 'The code is wrong or was already used');
      }
      startSession(request, reply, session.userId, true);
      audit(request, { event: 'auth.mfa', result: 'success' });
      return { ok: true as const };
    },
  );

  api.post(
    '/api/auth/totp/enrol',
    {
      config: { auth: { role: 'viewer', mfa: 'optional' } },
      schema: { response: { 200: totpEnrolmentResponse } },
    },
    async (request) => {
      const session = requireSession(request);
      // Replacing an existing factor needs a fresh re-authentication (ADR 0005).
      if (session.hasTotp && !(session.elevatedUntil !== null && session.elevatedUntil > now())) {
        throw new AppError(403, 'REAUTH_REQUIRED', 'Confirm your identity again to do this');
      }
      return beginTotpEnrolment(db, masterKey, session.userId, session.username);
    },
  );

  api.post(
    '/api/auth/totp/confirm',
    {
      config: { auth: { role: 'viewer', mfa: 'optional' } },
      schema: { body: codeRequest, response: { 200: backupCodesResponse } },
    },
    async (request, reply) => {
      const session = requireSession(request);
      const confirmed = verifyTotp({
        db,
        keys,
        userId: session.userId,
        username: session.username,
        code: request.body.code,
        now: now(),
        confirming: true,
      });
      if (!confirmed) throw new AppError(401, 'INVALID_CODE', 'The code is wrong or has expired');
      const backupCodes = issueBackupCodes(db, session.userId);
      startSession(request, reply, session.userId, true);
      audit(request, {
        event: 'auth.mfa_enrolled',
        result: 'success',
        targetType: 'user',
        targetId: String(session.userId),
      });
      return { backupCodes };
    },
  );

  api.post(
    '/api/auth/backup-codes',
    {
      config: { auth: { role: 'viewer', elevated: true } },
      schema: { response: { 200: backupCodesResponse } },
    },
    async (request) => {
      const session = requireSession(request);
      const backupCodes = issueBackupCodes(db, session.userId);
      audit(request, { event: 'auth.backup_codes_renewed', result: 'success' });
      return { backupCodes };
    },
  );

  api.post(
    '/api/auth/reauth',
    { config: { auth: { role: 'viewer' } }, schema: { body: reauthRequest, response: { 200: reauthResponse } } },
    async (request) => {
      const session = requireSession(request);
      const key = accountKey(session.username);
      const wait = throttle.accountWait(key);
      if (wait > 0) throw tooManyAttempts(wait);
      const stored = db.select().from(userPasswords).where(eq(userPasswords.userId, session.userId)).get();
      const passwordOk = await verifyPassword(stored?.hash ?? null, request.body.password);
      if (!passwordOk || !checkSecondFactor(session, request.body.code)) {
        if (!passwordOk) throttle.recordAccountFailure(key);
        audit(request, { event: 'auth.reauth', result: 'failure' });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Password or code is wrong');
      }
      const elevatedUntil = elevateSession(db, session.tokenHash, now());
      audit(request, { event: 'auth.reauth', result: 'success' });
      return { elevatedUntil };
    },
  );

  api.post(
    '/api/auth/logout',
    { config: { auth: { role: 'viewer', mfa: 'optional' } }, schema: { response: { 200: ok } } },
    async (request, reply) => {
      const session = requireSession(request);
      revokeSession(db, session.tokenHash);
      void reply.header('set-cookie', clearedSessionCookie());
      audit(request, { event: 'auth.logout', result: 'success' });
      return { ok: true as const };
    },
  );

  api.get(
    '/api/auth/sessions',
    { config: { auth: { role: 'viewer' } }, schema: { response: { 200: sessionListResponse } } },
    async (request) => {
      const session = requireSession(request);
      return {
        sessions: listSessions(db, session.userId).map((s) => ({
          id: s.prefix,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          ip: s.ip,
          userAgent: s.userAgent,
          current: s.tokenHash === session.tokenHash,
        })),
      };
    },
  );

  api.delete(
    '/api/auth/sessions/:id',
    {
      config: { auth: { role: 'viewer' } },
      schema: { params: z.object({ id: z.string().check(z.regex(/^[0-9a-f]{8}$/)) }), response: { 200: ok } },
    },
    async (request) => {
      const session = requireSession(request);
      if (!revokeSessionByPrefix(db, session.userId, request.params.id)) {
        throw new AppError(404, 'NOT_FOUND', 'No such session');
      }
      audit(request, {
        event: 'auth.session_revoked',
        result: 'success',
        targetType: 'session',
        targetId: request.params.id,
      });
      return { ok: true as const };
    },
  );

  api.post(
    '/api/auth/sessions/revoke-others',
    { config: { auth: { role: 'viewer' } }, schema: { response: { 200: z.object({ revoked: z.number() }) } } },
    async (request) => {
      const session = requireSession(request);
      const revoked = revokeUserSessions(db, session.userId, session.tokenHash);
      audit(request, { event: 'auth.sessions_revoked', result: 'success', details: { revoked } });
      return { revoked };
    },
  );
}
