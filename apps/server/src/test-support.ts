import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from './app.ts';
import { generateMasterKey, type MasterKey, parseMasterKey } from './crypto/master-key.ts';
import { type DatabaseHandle, openDatabase } from './db/database.ts';
import { migrateDatabase } from './db/migrate.ts';
import type { RegisteredPlugin } from './plugins.generated.ts';

/** In-memory database with all migrations applied, for tests. */
export function testDatabase(): DatabaseHandle {
  const handle = openDatabase(':memory:');
  migrateDatabase(handle, { backupDir: null });
  return handle;
}

export function testMasterKey(): MasterKey {
  return parseMasterKey(generateMasterKey(), 'test');
}

/** A small list instead of the real 10k file keeps tests independent of the asset. */
const TEST_COMMON_PASSWORDS: ReadonlySet<string> = new Set(['password', 'letmein', 'qwertyuiop']);

export interface TestApp {
  app: FastifyInstance;
  database: DatabaseHandle;
  masterKey: MasterKey;
  clock: { now: number };
}

/** App on an in-memory database with a controllable clock. */
export function testApp(
  start = Date.UTC(2026, 10, 16, 12),
  plugins?: readonly RegisteredPlugin[],
  options: { collectors?: boolean; heartbeatMs?: number } = {},
): TestApp {
  const database = testDatabase();
  const masterKey = testMasterKey();
  const clock = { now: start };
  const app = buildApp({
    version: '2.0.0-test',
    database,
    masterKey,
    commonPasswords: TEST_COMMON_PASSWORDS,
    now: () => clock.now,
    collectors: options.collectors ?? false,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(plugins ? { plugins } : {}),
  });
  return { app, database, masterKey, clock };
}

/** Returns the session token from a Set-Cookie header, or null. */
export function sessionTokenFrom(res: LightMyRequestResponse): string | null {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.match(/^__Host-rxf_session=([A-Za-z0-9_-]{43});/)?.[1] ?? null;
}

const ADMIN_PASSWORD = 'correct horse battery staple';

export interface SignedInClient {
  token: string;
  csrf: string;
  totpSecret: string;
}

/** Setup plus TOTP enrolment through the real endpoints; returns an admin whose second factor is done. */
export async function signedInAdmin(t: TestApp): Promise<SignedInClient> {
  const { issueSetupCode } = await import('./auth/setup.ts');
  const OTPAuth = await import('otpauth');
  const cookieOf = (res: LightMyRequestResponse) => sessionTokenFrom(res) as string;
  const csrfOf = async (token: string) =>
    (
      await t.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: { cookie: `__Host-rxf_session=${token}` },
      })
    ).json().csrfToken as string;
  const code = issueSetupCode(t.database.db, t.clock.now) as string;
  const setup = await t.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { code, username: 'robin', password: ADMIN_PASSWORD },
  });
  let token = cookieOf(setup);
  const headers = async () => ({ cookie: `__Host-rxf_session=${token}`, 'x-csrf-token': await csrfOf(token) });
  const enrol = await t.app.inject({ method: 'POST', url: '/api/auth/totp/enrol', headers: await headers() });
  const totpSecret = enrol.json().secret as string;
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totpSecret) });
  const confirm = await t.app.inject({
    method: 'POST',
    url: '/api/auth/totp/confirm',
    headers: await headers(),
    payload: { code: totp.generate({ timestamp: t.clock.now }) },
  });
  token = cookieOf(confirm);
  return { token, csrf: await csrfOf(token), totpSecret };
}

/** Re-authenticates the client so elevated routes open for 10 minutes. */
export async function elevate(t: TestApp, client: SignedInClient): Promise<void> {
  const OTPAuth = await import('otpauth');
  t.clock.now += 60_000;
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(client.totpSecret) }).generate({
    timestamp: t.clock.now,
  });
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/reauth',
    headers: { cookie: `__Host-rxf_session=${client.token}`, 'x-csrf-token': client.csrf },
    payload: { password: ADMIN_PASSWORD, code },
  });
  if (res.statusCode !== 200) throw new Error(`re-auth failed: ${res.body}`);
}
