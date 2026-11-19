import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, userWebauthnCredentials } from '../db/schema.ts';
import { sessionTokenFrom, type TestApp, testApp } from '../test-support.ts';
import { ChallengeStore } from './passkeys.ts';
import { issueSetupCode } from './setup.ts';

const ORIGIN = 'http://localhost:5173';
const RP_ID = 'localhost';
const PASSWORD = 'correct horse battery staple';

// Minimal CBOR encoder: just what attestation objects and COSE keys need.
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error('unsupported CBOR value');
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

/** A software authenticator with one discoverable P-256 credential and user verification. */
class TestAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #key: KeyObject;
  readonly #publicJwk: { x: string; y: string };
  #counter = 0;
  userHandle = '';

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    this.#publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  #clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(options: Record<string, unknown>, origin = ORIGIN) {
    const challenge = options.challenge as string;
    this.userHandle = (options.user as { id: string }).id;
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(this.#publicJwk.x, 'base64url')],
        [-3, Buffer.from(this.#publicJwk.y, 'base64url')],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256((options.rp as { id: string }).id),
      Buffer.from([0x45]), // UP | UV | AT
      Buffer.alloc(4),
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.#clientData('webauthn.create', challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  get(options: Record<string, unknown>, tamper = false) {
    this.#counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), counter]);
    const clientData = this.#clientData('webauthn.get', options.challenge as string, ORIGIN);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.#key);
    if (tamper) signature.writeUInt8(signature.readUInt8(signature.length - 1) ^ 1, signature.length - 1);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

let t: TestApp;

beforeEach(() => {
  t = testApp();
});

afterEach(() => {
  t.database.sqlite.close();
});

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string | null,
  payload?: Record<string, unknown>,
) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.cookie = `__Host-rxf_session=${token}`;
    const session = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers });
    if (session.json().csrfToken) headers['x-csrf-token'] = session.json().csrfToken;
  }
  return payload === undefined
    ? t.app.inject({ method, url, headers })
    : t.app.inject({ method, url, headers, payload });
}

/** First admin via the setup code, without a second factor yet. */
async function setupAdmin(): Promise<string> {
  const code = issueSetupCode(t.database.db, t.clock.now) as string;
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { code, username: 'robin', password: PASSWORD },
  });
  return sessionTokenFrom(res) as string;
}

async function registerPasskey(token: string, authenticator: TestAuthenticator, name = 'Laptop') {
  const options = await call('POST', '/api/auth/passkeys/register/options', token);
  expect(options.statusCode).toBe(200);
  return call('POST', '/api/auth/passkeys/register', token, {
    response: authenticator.create(options.json().options),
    name,
  });
}

async function passkeyLogin(authenticator: TestAuthenticator, tamper = false) {
  const options = await call('POST', '/api/auth/passkeys/login/options', null);
  return call('POST', '/api/auth/passkeys/login', null, {
    response: authenticator.get(options.json().options, tamper),
  });
}

describe('passkeys', () => {
  it('enrol as the first factor: backup codes, a completed session, others signed out', async () => {
    const token = await setupAdmin();
    const options = await call('POST', '/api/auth/passkeys/register/options', token);
    const opts = options.json().options;
    expect(opts.rp).toEqual({ name: 'rxf-sys Control', id: RP_ID });
    expect(opts.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });

    const authenticator = new TestAuthenticator();
    const res = await call('POST', '/api/auth/passkeys/register', token, {
      response: authenticator.create(opts),
      name: 'Laptop',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().backupCodes).toHaveLength(10);
    const rotated = sessionTokenFrom(res) as string;
    expect(rotated).not.toBe(token);
    const session = await call('GET', '/api/auth/session', rotated);
    expect(session.json().mfa).toBe('done');
    expect((await call('GET', '/api/auth/session', token)).json().authenticated).toBe(false);

    const list = await call('GET', '/api/auth/passkeys', rotated);
    expect(list.json().passkeys).toEqual([
      {
        id: b64url(authenticator.credentialId),
        name: 'Laptop',
        createdAt: t.clock.now,
        lastUsedAt: null,
        synced: false,
      },
    ]);
  });

  it('signs in without a password, counts as MFA, and refuses tampered, replayed or unknown assertions', async () => {
    const authenticator = new TestAuthenticator();
    await registerPasskey(await setupAdmin(), authenticator);

    const login = await passkeyLogin(authenticator);
    expect(login.json()).toEqual({ mfa: 'done' });
    const session = await call('GET', '/api/auth/session', sessionTokenFrom(login));
    expect(session.json()).toMatchObject({ authenticated: true, mfa: 'done', user: { username: 'robin' } });

    expect((await passkeyLogin(authenticator, true)).json().error.code).toBe('INVALID_PASSKEY');
    expect((await passkeyLogin(new TestAuthenticator())).json().error.code).toBe('INVALID_PASSKEY');

    // A challenge works once.
    const options = (await call('POST', '/api/auth/passkeys/login/options', null)).json().options;
    const assertion = authenticator.get(options);
    expect((await call('POST', '/api/auth/passkeys/login', null, { response: assertion })).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/passkeys/login', null, { response: assertion })).statusCode).toBe(401);

    const failures = t.database.db
      .select()
      .from(auditEvents)
      .all()
      .filter((e) => e.event === 'auth.login');
    expect(failures.filter((e) => e.result === 'failure')).toHaveLength(3);
  });

  it('a password sign-in of a passkey-only account waits for the second factor', async () => {
    await registerPasskey(await setupAdmin(), new TestAuthenticator());
    const login = await call('POST', '/api/auth/login', null, { username: 'robin', password: PASSWORD });
    expect(login.json()).toEqual({ mfa: 'pending' });
  });

  it('re-authenticates with a passkey bound to the asking session', async () => {
    const authenticator = new TestAuthenticator();
    const first = await registerPasskey(await setupAdmin(), authenticator);
    const token = sessionTokenFrom(first) as string;

    const options = await call('POST', '/api/auth/reauth/passkey/options', token);
    expect(options.json().options.allowCredentials).toEqual([
      { id: b64url(authenticator.credentialId), type: 'public-key', transports: ['internal'] },
    ]);
    const res = await call('POST', '/api/auth/reauth/passkey', token, {
      response: authenticator.get(options.json().options),
    });
    expect(res.json().elevatedUntil).toBe(t.clock.now + 10 * 60_000);

    // A login challenge is not valid for re-authentication.
    const login = (await call('POST', '/api/auth/passkeys/login/options', null)).json().options;
    const wrong = await call('POST', '/api/auth/reauth/passkey', token, { response: authenticator.get(login) });
    expect(wrong.json().error.code).toBe('INVALID_PASSKEY');
  });

  it('adding needs a re-authentication once a factor exists; the last factor cannot be removed', async () => {
    const authenticator = new TestAuthenticator();
    const token = sessionTokenFrom(await registerPasskey(await setupAdmin(), authenticator)) as string;

    expect((await call('POST', '/api/auth/passkeys/register/options', token)).json().error.code).toBe(
      'REAUTH_REQUIRED',
    );
    const id = b64url(authenticator.credentialId);
    expect((await call('DELETE', `/api/auth/passkeys/${id}`, token)).json().error.code).toBe('REAUTH_REQUIRED');

    const reauth = (await call('POST', '/api/auth/reauth/passkey/options', token)).json().options;
    await call('POST', '/api/auth/reauth/passkey', token, { response: authenticator.get(reauth) });

    expect((await call('DELETE', `/api/auth/passkeys/${id}`, token)).json().error.code).toBe('LAST_FACTOR');

    const second = new TestAuthenticator();
    const added = await registerPasskey(token, second, 'Telefon');
    expect(added.json()).toEqual({});
    expect((await call('DELETE', `/api/auth/passkeys/${id}`, token)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/api/auth/passkeys/${id}`, token)).statusCode).toBe(404);
    expect(
      t.database.db
        .select()
        .from(userWebauthnCredentials)
        .all()
        .map((c) => c.name),
    ).toEqual(['Telefon']);
  });

  it('an account with TOTP may drop its only passkey; a wrong origin is refused at registration', async () => {
    let token = await setupAdmin();
    const enrol = await call('POST', '/api/auth/totp/enrol', token);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrol.json().secret) });
    const confirm = await call('POST', '/api/auth/totp/confirm', token, {
      code: totp.generate({ timestamp: t.clock.now }),
    });
    token = sessionTokenFrom(confirm) as string;
    t.clock.now += 60_000;
    await call('POST', '/api/auth/reauth', token, {
      password: PASSWORD,
      code: totp.generate({ timestamp: t.clock.now }),
    });

    const options = (await call('POST', '/api/auth/passkeys/register/options', token)).json().options;
    const foreign = await call('POST', '/api/auth/passkeys/register', token, {
      response: new TestAuthenticator().create(options, 'https://evil.example'),
      name: 'Fremd',
    });
    expect(foreign.json().error.code).toBe('INVALID_PASSKEY');

    const authenticator = new TestAuthenticator();
    expect((await registerPasskey(token, authenticator)).json()).toEqual({});
    const id = b64url(authenticator.credentialId);
    expect((await call('DELETE', `/api/auth/passkeys/${id}`, token)).json()).toEqual({ ok: true });
    expect((await call('POST', '/api/auth/reauth/passkey/options', token)).json().error.code).toBe('NO_PASSKEY');
  });
});

describe('ChallengeStore', () => {
  it('honours purpose, binding and expiry, and limits pending challenges', () => {
    const clock = { now: 0 };
    const store = new ChallengeStore(() => clock.now);
    const key = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const a = key(store.issue('reauth', 'session-a'));
    expect(store.consume(a, 'reauth', 'session-b')).toBe(false);
    expect(store.consume(a, 'reauth', 'session-a')).toBe(false);
    const b = key(store.issue('login', null));
    clock.now = 5 * 60_000;
    expect(store.consume(b, 'login', null)).toBe(false);
    for (let i = 0; i < 1_000; i++) store.issue('login', null);
    expect(() => store.issue('login', null)).toThrow(/Too many pending/);
    clock.now += 5 * 60_000 + 1;
    expect(store.consume(key(store.issue('login', null)), 'login', null)).toBe(true);
  });
});
