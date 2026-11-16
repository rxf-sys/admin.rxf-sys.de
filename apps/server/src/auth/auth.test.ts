import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import * as OTPAuth from 'otpauth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, sessions, userPasswords, users } from '../db/schema.ts';
import { sessionTokenFrom, type TestApp, testApp } from '../test-support.ts';
import { hashPassword } from './passwords.ts';
import { IDLE_TIMEOUT_MS } from './sessions.ts';
import { issueSetupCode } from './setup.ts';

const PASSWORD = 'correct horse battery staple';

function totpCode(secret: string, timestamp: number): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp });
}

interface Client {
  token: string;
  csrf: string;
}

describe('auth', () => {
  let t: TestApp;
  let app: FastifyInstance;

  beforeEach(() => {
    t = testApp();
    app = t.app;
    app.get('/api/test/viewer', { config: { auth: { role: 'viewer' } } }, async () => ({ ok: true }));
    app.post('/api/test/viewer', { config: { auth: { role: 'viewer' } } }, async () => ({ ok: true }));
    app.get('/api/test/admin', { config: { auth: { role: 'admin' } } }, async () => ({ ok: true }));
    app.post('/api/test/elevated', { config: { auth: { role: 'viewer', elevated: true } } }, async () => ({
      ok: true,
    }));
  });

  afterEach(async () => {
    await app.close();
  });

  const cookie = (token: string) => ({ cookie: `__Host-rxf_session=${token}` });

  async function call(options: InjectOptions & { client?: Client }) {
    const { client, ...rest } = options;
    const headers = {
      ...(rest.headers ?? {}),
      ...(client ? { ...cookie(client.token), 'x-csrf-token': client.csrf } : {}),
    };
    return app.inject({ ...rest, headers });
  }

  async function sessionOf(token: string) {
    return (await app.inject({ method: 'GET', url: '/api/auth/session', headers: cookie(token) })).json();
  }

  async function clientFor(token: string): Promise<Client> {
    return { token, csrf: (await sessionOf(token)).csrfToken };
  }

  /** Runs setup, TOTP enrolment and confirmation; returns a fully signed-in admin. */
  async function bootstrapAdmin(username = 'robin') {
    const code = issueSetupCode(t.database.db, t.clock.now) as string;
    const setup = await call({ method: 'POST', url: '/api/setup', payload: { code, username, password: PASSWORD } });
    expect(setup.statusCode).toBe(201);
    const pending = await clientFor(sessionTokenFrom(setup) as string);
    const enrol = await call({ method: 'POST', url: '/api/auth/totp/enrol', client: pending });
    expect(enrol.statusCode).toBe(200);
    const { secret } = enrol.json();
    const confirm = await call({
      method: 'POST',
      url: '/api/auth/totp/confirm',
      client: pending,
      payload: { code: totpCode(secret, t.clock.now) },
    });
    expect(confirm.statusCode).toBe(200);
    const client = await clientFor(sessionTokenFrom(confirm) as string);
    return { client, secret, backupCodes: confirm.json().backupCodes as string[], pendingToken: pending.token };
  }

  async function addUser(
    username: string,
    role: 'viewer' | 'operator' | 'admin',
    status: 'active' | 'disabled' = 'active',
  ) {
    const user = t.database.db
      .insert(users)
      .values({ username, role, status, createdAt: t.clock.now })
      .returning({ id: users.id })
      .get();
    t.database.db
      .insert(userPasswords)
      .values({ userId: user.id, hash: await hashPassword(PASSWORD), updatedAt: t.clock.now })
      .run();
    return user.id;
  }

  function auditTrail() {
    return t.database.db.select().from(auditEvents).all();
  }

  describe('setup', () => {
    it('reports an open setup to anonymous visitors', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/auth/session' })).json()).toEqual({
        authenticated: false,
        setupOpen: true,
      });
    });

    it('creates the first admin, sets a hardened cookie and closes for good', async () => {
      const code = issueSetupCode(t.database.db, t.clock.now) as string;
      expect(code).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
      const res = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code: code.toLowerCase(), username: 'robin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      expect(res.headers['set-cookie']).toMatch(
        /^__Host-rxf_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/,
      );
      const session = await sessionOf(sessionTokenFrom(res) as string);
      expect(session).toMatchObject({
        authenticated: true,
        user: { username: 'robin', role: 'admin' },
        mfa: 'setup_required',
      });

      const again = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code, username: 'eve', password: PASSWORD },
      });
      expect(again.statusCode).toBe(404);
      expect(issueSetupCode(t.database.db, t.clock.now)).toBeNull();
      expect(auditTrail().map((e) => e.event)).toContain('setup.completed');
    });

    it('rejects a wrong or expired code and a weak password', async () => {
      const code = issueSetupCode(t.database.db, t.clock.now) as string;
      const wrong = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code: 'AAAAA', username: 'robin', password: PASSWORD },
      });
      expect(wrong.json().error.code).toBe('INVALID_SETUP_CODE');
      const weak = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code, username: 'robin', password: 'Password1234!' },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().error).toMatchObject({ code: 'WEAK_PASSWORD', details: { problem: 'too_common' } });
      t.clock.now += 24 * 60 * 60_000;
      const expired = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code, username: 'robin', password: PASSWORD },
      });
      expect(expired.json().error.code).toBe('INVALID_SETUP_CODE');
    });

    it('throttles code guessing per IP', async () => {
      issueSetupCode(t.database.db, t.clock.now);
      for (let i = 0; i < 5; i++) {
        await call({
          method: 'POST',
          url: '/api/setup',
          payload: { code: 'WRONG', username: 'robin', password: PASSWORD },
        });
      }
      const blocked = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code: 'WRONG', username: 'robin', password: PASSWORD },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.details.retryAfterSeconds).toBe(300);
    });

    it('replaces the code on every issue while setup is open', () => {
      const first = issueSetupCode(t.database.db, t.clock.now);
      const second = issueSetupCode(t.database.db, t.clock.now);
      expect(second).not.toBe(first);
    });
  });

  describe('second factor', () => {
    it('enrols TOTP, hands out ten backup codes once and rotates the session', async () => {
      const { client, backupCodes, pendingToken } = await bootstrapAdmin();
      expect(backupCodes).toHaveLength(10);
      expect(backupCodes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect((await sessionOf(client.token)).mfa).toBe('done');
      expect((await sessionOf(pendingToken)).authenticated).toBe(false);
    });

    it('keeps a password-only session away from everything but enrolment', async () => {
      const code = issueSetupCode(t.database.db, t.clock.now) as string;
      const setup = await call({
        method: 'POST',
        url: '/api/setup',
        payload: { code, username: 'robin', password: PASSWORD },
      });
      const pending = await clientFor(sessionTokenFrom(setup) as string);
      const res = await call({ method: 'GET', url: '/api/test/viewer', client: pending });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MFA_REQUIRED');
    });

    it('signs in with password plus TOTP and refuses a replayed code', async () => {
      const { secret } = await bootstrapAdmin();
      t.clock.now += 60_000;
      const login = await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'robin', password: PASSWORD },
      });
      expect(login.json()).toEqual({ mfa: 'pending' });
      const pending = await clientFor(sessionTokenFrom(login) as string);
      const code = totpCode(secret, t.clock.now);
      const verified = await call({ method: 'POST', url: '/api/auth/2fa', client: pending, payload: { code } });
      expect(verified.statusCode).toBe(200);
      const done = await clientFor(sessionTokenFrom(verified) as string);
      expect((await call({ method: 'GET', url: '/api/test/viewer', client: done })).statusCode).toBe(200);

      const second = await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'robin', password: PASSWORD },
      });
      const pending2 = await clientFor(sessionTokenFrom(second) as string);
      const replay = await call({ method: 'POST', url: '/api/auth/2fa', client: pending2, payload: { code } });
      expect(replay.json().error.code).toBe('INVALID_CODE');
    });

    it('accepts each backup code exactly once', async () => {
      const { backupCodes } = await bootstrapAdmin();
      const backup = backupCodes[0] as string;
      for (const expected of [200, 401]) {
        const login = await call({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'robin', password: PASSWORD },
        });
        const pending = await clientFor(sessionTokenFrom(login) as string);
        const res = await call({
          method: 'POST',
          url: '/api/auth/2fa',
          client: pending,
          payload: { code: backup.toLowerCase() },
        });
        expect(res.statusCode).toBe(expected);
      }
    });

    it('needs a fresh re-authentication to replace an enrolled factor', async () => {
      const { client, secret } = await bootstrapAdmin();
      const blocked = await call({ method: 'POST', url: '/api/auth/totp/enrol', client });
      expect(blocked.json().error.code).toBe('REAUTH_REQUIRED');
      t.clock.now += 60_000;
      const reauth = await call({
        method: 'POST',
        url: '/api/auth/reauth',
        client,
        payload: { password: PASSWORD, code: totpCode(secret, t.clock.now) },
      });
      expect(reauth.json().elevatedUntil).toBe(t.clock.now + 10 * 60_000);
      expect((await call({ method: 'POST', url: '/api/auth/totp/enrol', client })).statusCode).toBe(200);
    });
  });

  describe('login', () => {
    it('answers unknown, disabled and wrong accounts the same way', async () => {
      await addUser('anna', 'viewer');
      await addUser('olaf', 'viewer', 'disabled');
      const answers = await Promise.all(
        [
          { username: 'nobody', password: PASSWORD },
          { username: 'olaf', password: PASSWORD },
          { username: 'anna', password: 'wrong password here' },
        ].map((payload) => call({ method: 'POST', url: '/api/auth/login', payload })),
      );
      for (const res of answers) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({
          error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is wrong' },
        });
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    });

    it('backs off an account after five failures, also for names that do not exist', async () => {
      for (const name of ['anna', 'ghost']) {
        if (name === 'anna') await addUser('anna', 'viewer');
        for (let i = 0; i < 5; i++) {
          await call({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: name, password: 'nope nope nope' },
          });
        }
        const locked = await call({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: name, password: PASSWORD },
        });
        expect(locked.statusCode).toBe(429);
        expect(locked.json().error.details.retryAfterSeconds).toBe(30);
      }
      t.clock.now += 30_000;
      const after = await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'anna', password: PASSWORD },
      });
      expect(after.statusCode).toBe(200);
    });

    it('limits failures per client IP', async () => {
      for (let i = 0; i < 20; i++) {
        await call({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: `user${i}`, password: 'nope nope nope' },
        });
      }
      const res = await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'fresh', password: 'nope' },
      });
      expect(res.statusCode).toBe(429);
    });

    it('rotates the session: the browser loses its previous session at sign-in', async () => {
      await addUser('anna', 'viewer');
      const first = sessionTokenFrom(
        await call({ method: 'POST', url: '/api/auth/login', payload: { username: 'anna', password: PASSWORD } }),
      ) as string;
      const second = await call({
        method: 'POST',
        url: '/api/auth/login',
        headers: cookie(first),
        payload: { username: 'anna', password: PASSWORD },
      });
      expect(sessionTokenFrom(second)).not.toBe(first);
      expect((await sessionOf(first)).authenticated).toBe(false);
    });

    it('records the attempt in the audit log without the password', async () => {
      await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'anna', password: 'secret-attempt-123' },
      });
      const [entry] = auditTrail();
      expect(entry).toMatchObject({ event: 'auth.login', result: 'failure', actorIp: '127.0.0.1' });
      expect(JSON.stringify(auditTrail())).not.toContain('secret-attempt-123');
    });
  });

  describe('route guard with sessions', () => {
    it('checks the role on the server', async () => {
      const { client } = await bootstrapAdmin();
      expect((await call({ method: 'GET', url: '/api/test/admin', client })).statusCode).toBe(200);
      t.database.db.update(users).set({ role: 'viewer' }).run();
      const res = await call({ method: 'GET', url: '/api/test/admin', client });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('requires the CSRF token on state-changing requests', async () => {
      const { client } = await bootstrapAdmin();
      const missing = await app.inject({ method: 'POST', url: '/api/test/viewer', headers: cookie(client.token) });
      expect(missing.json().error.code).toBe('CSRF_TOKEN_INVALID');
      const wrong = await call({
        method: 'POST',
        url: '/api/test/viewer',
        client: { ...client, csrf: 'x'.repeat(43) },
      });
      expect(wrong.json().error.code).toBe('CSRF_TOKEN_INVALID');
      expect((await call({ method: 'POST', url: '/api/test/viewer', client })).statusCode).toBe(200);
    });

    it('requires a recent re-authentication on elevated routes', async () => {
      const { client, secret } = await bootstrapAdmin();
      expect((await call({ method: 'POST', url: '/api/test/elevated', client })).json().error.code).toBe(
        'REAUTH_REQUIRED',
      );
      t.clock.now += 60_000;
      await call({
        method: 'POST',
        url: '/api/auth/reauth',
        client,
        payload: { password: PASSWORD, code: totpCode(secret, t.clock.now) },
      });
      expect((await call({ method: 'POST', url: '/api/test/elevated', client })).statusCode).toBe(200);
      t.clock.now += 10 * 60_000;
      expect((await call({ method: 'POST', url: '/api/test/elevated', client })).statusCode).toBe(403);
    });

    it('refuses re-authentication with a wrong password', async () => {
      const { client, secret } = await bootstrapAdmin();
      t.clock.now += 60_000;
      const res = await call({
        method: 'POST',
        url: '/api/auth/reauth',
        client,
        payload: { password: 'not it at all', code: totpCode(secret, t.clock.now) },
      });
      expect(res.statusCode).toBe(401);
    });

    it('ends idle sessions after 12 hours and every session after 7 days', async () => {
      const { client } = await bootstrapAdmin();
      t.clock.now += IDLE_TIMEOUT_MS - 1;
      expect((await sessionOf(client.token)).authenticated).toBe(true);
      // Keep the session busy (never idle 12 h) until well past the 7-day absolute lifetime.
      for (let step = 0; step < 15; step++) {
        t.clock.now += 11 * 60 * 60_000;
        await sessionOf(client.token);
      }
      expect((await sessionOf(client.token)).authenticated).toBe(false);
    });

    it('ends idle sessions', async () => {
      const { client } = await bootstrapAdmin();
      t.clock.now += IDLE_TIMEOUT_MS;
      expect((await sessionOf(client.token)).authenticated).toBe(false);
    });

    it('drops sessions of disabled accounts', async () => {
      const { client } = await bootstrapAdmin();
      t.database.db.update(users).set({ status: 'disabled' }).run();
      expect((await call({ method: 'GET', url: '/api/test/viewer', client })).statusCode).toBe(401);
    });
  });

  describe('session management', () => {
    it('lists sessions, revokes one and signs out elsewhere', async () => {
      const { client, secret } = await bootstrapAdmin();
      t.clock.now += 60_000;
      const login = await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'robin', password: PASSWORD },
      });
      const other = sessionTokenFrom(login) as string;

      const list = (await call({ method: 'GET', url: '/api/auth/sessions', client })).json().sessions;
      expect(list).toHaveLength(2);
      const notCurrent = list.find((s: { current: boolean }) => !s.current);
      expect((await call({ method: 'DELETE', url: `/api/auth/sessions/${notCurrent.id}`, client })).statusCode).toBe(
        200,
      );
      expect((await sessionOf(other)).authenticated).toBe(false);

      const third = await call({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'robin', password: PASSWORD },
      });
      const thirdPending = await clientFor(sessionTokenFrom(third) as string);
      await call({
        method: 'POST',
        url: '/api/auth/2fa',
        client: thirdPending,
        payload: { code: totpCode(secret, t.clock.now) },
      });
      const revoked = await call({ method: 'POST', url: '/api/auth/sessions/revoke-others', client });
      expect(revoked.json().revoked).toBe(1);
      expect(t.database.db.select().from(sessions).all()).toHaveLength(1);
    });

    it('signs out and clears the cookie', async () => {
      const { client } = await bootstrapAdmin();
      const res = await call({ method: 'POST', url: '/api/auth/logout', client });
      expect(res.headers['set-cookie']).toMatch(/^__Host-rxf_session=; Path=\/; Max-Age=0;/);
      expect((await sessionOf(client.token)).authenticated).toBe(false);
    });

    it('renews backup codes only after re-authentication', async () => {
      const { client, secret } = await bootstrapAdmin();
      expect((await call({ method: 'POST', url: '/api/auth/backup-codes', client })).statusCode).toBe(403);
      t.clock.now += 60_000;
      await call({
        method: 'POST',
        url: '/api/auth/reauth',
        client,
        payload: { password: PASSWORD, code: totpCode(secret, t.clock.now) },
      });
      const renewed = await call({ method: 'POST', url: '/api/auth/backup-codes', client });
      expect(renewed.json().backupCodes).toHaveLength(10);
    });
  });

  it('never stores raw tokens', async () => {
    const { client } = await bootstrapAdmin();
    const stored = t.database.db.select().from(sessions).where(eq(sessions.prefix, sessions.prefix)).all();
    expect(JSON.stringify(stored)).not.toContain(client.token);
  });
});
