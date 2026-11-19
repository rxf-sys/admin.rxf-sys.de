import { randomBytes } from 'node:crypto';
import {
  passkeyAssertionRequest,
  passkeyListResponse,
  passkeyOptionsResponse,
  passkeyRegisterRequest,
  passkeyRegisterResponse,
} from '@rxf/contracts';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod/mini';
import type { recordAudit } from '../audit.ts';
import type { Db } from '../db/database.ts';
import { users, userWebauthnCredentials } from '../db/schema.ts';
import { AppError } from '../http/errors.ts';
import { issueBackupCodes } from './second-factor.ts';
import { elevateSession, revokeUserSessions, type Session } from './sessions.ts';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PENDING_CHALLENGES = 1_000;

type Purpose = 'register' | 'login' | 'reauth';

/**
 * One-time challenges, bound to their purpose and (except for passwordless login) to the session that asked
 * for them. In memory: a restart only means asking again.
 */
export class ChallengeStore {
  readonly #pending = new Map<string, { purpose: Purpose; binding: string | null; expires: number }>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Returns the challenge bytes for the options; the browser echoes them back base64url-encoded. */
  issue(purpose: Purpose, binding: string | null): Uint8Array<ArrayBuffer> {
    const t = this.#now();
    for (const [key, entry] of this.#pending) if (entry.expires <= t) this.#pending.delete(key);
    if (this.#pending.size >= MAX_PENDING_CHALLENGES) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many pending passkey requests, try again shortly', {
        retryAfterSeconds: 60,
      });
    }
    const challenge = new Uint8Array(randomBytes(32));
    this.#pending.set(Buffer.from(challenge).toString('base64url'), {
      purpose,
      binding,
      expires: t + CHALLENGE_TTL_MS,
    });
    return challenge;
  }

  /** True once for a (base64url) challenge of the right purpose and binding; gone afterwards either way. */
  consume(challenge: string, purpose: Purpose, binding: string | null): boolean {
    const entry = this.#pending.get(challenge);
    this.#pending.delete(challenge);
    return entry !== undefined && entry.purpose === purpose && entry.binding === binding && entry.expires > this.#now();
  }
}

export interface PasskeyDeps {
  db: Db;
  now: () => number;
  /** e.g. https://admin.rxf-sys.de; the RP ID is its hostname. */
  publicOrigin: string;
  requireSession(request: FastifyRequest): Session;
  startSession(request: FastifyRequest, reply: FastifyReply, userId: number, mfaDone: boolean): void;
  assertMayChangeFactor(session: Session): void;
  /** Throws 429 while the IP is locked out of sign-ins; records a failure when called with `failed`. */
  loginGate(request: FastifyRequest, failed?: boolean): void;
  audit(request: FastifyRequest, entry: Parameters<typeof recordAudit>[1]): void;
}

const credentialId = z.string().check(z.regex(/^[A-Za-z0-9_-]{16,512}$/));
const idParams = z.object({ id: credentialId });
const ok = z.object({ ok: z.literal(true) });
const mfaDone = z.object({ mfa: z.literal('done') });

const invalidPasskey = () => new AppError(401, 'INVALID_PASSKEY', 'The passkey could not be verified');

/**
 * @simplewebauthn throws on any malformed or mismatching response (wrong challenge, origin, signature);
 * for the caller all of these mean the same: not verified. Their details stay out of the answer.
 */
const notVerified = () => null;

/** Passkey routes (ADR 0005): register, passwordless sign-in (counts as MFA), re-authentication, list, delete. */
export function registerPasskeyRoutes(app: FastifyInstance, deps: PasskeyDeps): void {
  const { db, now } = deps;
  const rpID = new URL(deps.publicOrigin).hostname;
  const expectedOrigin = deps.publicOrigin;
  const challenges = new ChallengeStore(now);
  const api = app.withTypeProvider<ZodTypeProvider>();

  const credentialsOf = (userId: number) =>
    db.select().from(userWebauthnCredentials).where(eq(userWebauthnCredentials.userId, userId)).all();
  const descriptors = (userId: number) =>
    credentialsOf(userId).map((c) => ({ id: c.id, transports: JSON.parse(c.transportsJson) as string[] }));

  /** Verifies an assertion against the stored credential and bumps its counter; returns the owner's id. */
  async function verifyAssertion(
    response: AuthenticationResponseJSON,
    purpose: Purpose,
    binding: string | null,
  ): Promise<number | null> {
    const stored =
      typeof response.id === 'string'
        ? db.select().from(userWebauthnCredentials).where(eq(userWebauthnCredentials.id, response.id)).get()
        : undefined;
    if (!stored) return null;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) => challenges.consume(challenge, purpose, binding),
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: JSON.parse(stored.transportsJson) as string[],
      },
    }).catch(notVerified);
    if (!result?.verified) return null;
    db.update(userWebauthnCredentials)
      .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: now() })
      .where(eq(userWebauthnCredentials.id, stored.id))
      .run();
    return stored.userId;
  }

  api.post(
    '/api/auth/passkeys/register/options',
    { config: { auth: { role: 'viewer', mfa: 'optional' } }, schema: { response: { 200: passkeyOptionsResponse } } },
    async (request) => {
      const session = deps.requireSession(request);
      deps.assertMayChangeFactor(session);
      const options = await generateRegistrationOptions({
        rpName: 'rxf-sys Control',
        rpID,
        userName: session.username,
        userID: new TextEncoder().encode(`rxf-user-${session.userId}`),
        challenge: challenges.issue('register', session.tokenHash),
        attestationType: 'none',
        excludeCredentials: descriptors(session.userId),
        // Discoverable, so the passkey alone can sign in; verified user, so it counts as two factors.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      return { options: options as unknown as Record<string, unknown> };
    },
  );

  api.post(
    '/api/auth/passkeys/register',
    {
      config: { auth: { role: 'viewer', mfa: 'optional' } },
      schema: { body: passkeyRegisterRequest, response: { 200: passkeyRegisterResponse } },
    },
    async (request, reply) => {
      const session = deps.requireSession(request);
      deps.assertMayChangeFactor(session);
      const result = await verifyRegistrationResponse({
        response: request.body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: (challenge) => challenges.consume(challenge, 'register', session.tokenHash),
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      }).catch(notVerified);
      if (!result?.verified) {
        deps.audit(request, { event: 'auth.passkey_added', result: 'failure' });
        throw invalidPasskey();
      }
      const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
      const firstFactor = !session.hasTotp && !session.hasPasskey;
      db.insert(userWebauthnCredentials)
        .values({
          id: credential.id,
          userId: session.userId,
          publicKey: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transportsJson: JSON.stringify(credential.transports ?? []),
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          name: request.body.name,
          createdAt: now(),
        })
        .run();
      deps.audit(request, {
        event: 'auth.passkey_added',
        result: 'success',
        targetType: 'user',
        targetId: String(session.userId),
      });
      if (!firstFactor) return {};
      // First factor of the account: like a confirmed TOTP, it completes the sign-in, brings backup codes
      // and ends every other session of the account.
      const backupCodes = issueBackupCodes(db, session.userId);
      revokeUserSessions(db, session.userId, session.tokenHash);
      deps.startSession(request, reply, session.userId, true);
      return { backupCodes };
    },
  );

  api.post(
    '/api/auth/passkeys/login/options',
    { config: { auth: { role: 'public' } }, schema: { response: { 200: passkeyOptionsResponse } } },
    async (request) => {
      deps.loginGate(request);
      const options = await generateAuthenticationOptions({
        rpID,
        challenge: challenges.issue('login', null),
        userVerification: 'required',
      });
      return { options: options as unknown as Record<string, unknown> };
    },
  );

  api.post(
    '/api/auth/passkeys/login',
    {
      config: { auth: { role: 'public' } },
      schema: { body: passkeyAssertionRequest, response: { 200: mfaDone } },
    },
    async (request, reply) => {
      deps.loginGate(request);
      const userId = await verifyAssertion(
        request.body.response as unknown as AuthenticationResponseJSON,
        'login',
        null,
      );
      const user = userId === null ? undefined : db.select().from(users).where(eq(users.id, userId)).get();
      if (user?.status !== 'active') {
        deps.loginGate(request, true);
        deps.audit(request, { event: 'auth.login', result: 'failure', details: { method: 'passkey' } });
        throw invalidPasskey();
      }
      // A verified passkey is possession plus user verification: the session starts with MFA done.
      deps.startSession(request, reply, user.id, true);
      deps.audit(request, {
        event: 'auth.login',
        result: 'success',
        actorUserId: user.id,
        details: { method: 'passkey' },
      });
      return { mfa: 'done' as const };
    },
  );

  api.post(
    '/api/auth/reauth/passkey/options',
    { config: { auth: { role: 'viewer' } }, schema: { response: { 200: passkeyOptionsResponse } } },
    async (request) => {
      const session = deps.requireSession(request);
      const allowCredentials = descriptors(session.userId);
      if (allowCredentials.length === 0) throw new AppError(409, 'NO_PASSKEY', 'This account has no passkey');
      const options = await generateAuthenticationOptions({
        rpID,
        challenge: challenges.issue('reauth', session.tokenHash),
        allowCredentials,
        userVerification: 'required',
      });
      return { options: options as unknown as Record<string, unknown> };
    },
  );

  api.post(
    '/api/auth/reauth/passkey',
    {
      config: { auth: { role: 'viewer' } },
      schema: { body: passkeyAssertionRequest, response: { 200: z.object({ elevatedUntil: z.number() }) } },
    },
    async (request) => {
      const session = deps.requireSession(request);
      const userId = await verifyAssertion(
        request.body.response as unknown as AuthenticationResponseJSON,
        'reauth',
        session.tokenHash,
      );
      if (userId !== session.userId) {
        deps.audit(request, { event: 'auth.reauth', result: 'failure', details: { method: 'passkey' } });
        throw invalidPasskey();
      }
      const elevatedUntil = elevateSession(db, session.tokenHash, now());
      deps.audit(request, { event: 'auth.reauth', result: 'success', details: { method: 'passkey' } });
      return { elevatedUntil };
    },
  );

  api.get(
    '/api/auth/passkeys',
    { config: { auth: { role: 'viewer' } }, schema: { response: { 200: passkeyListResponse } } },
    async (request) => ({
      passkeys: credentialsOf(deps.requireSession(request).userId).map((c) => ({
        id: c.id,
        name: c.name,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        synced: c.backedUp,
      })),
    }),
  );

  api.delete(
    '/api/auth/passkeys/:id',
    {
      config: { auth: { role: 'viewer', elevated: true } },
      schema: { params: idParams, response: { 200: ok } },
    },
    async (request) => {
      const session = deps.requireSession(request);
      const own = credentialsOf(session.userId);
      if (!own.some((c) => c.id === request.params.id)) {
        throw new AppError(404, 'NOT_FOUND', 'No such passkey');
      }
      // The second factor is mandatory (ADR 0005): the last one cannot go.
      if (own.length === 1 && !session.hasTotp) {
        throw new AppError(409, 'LAST_FACTOR', 'Set up another second factor before removing this passkey');
      }
      db.delete(userWebauthnCredentials)
        .where(
          and(eq(userWebauthnCredentials.id, request.params.id), eq(userWebauthnCredentials.userId, session.userId)),
        )
        .run();
      deps.audit(request, {
        event: 'auth.passkey_removed',
        result: 'success',
        targetType: 'user',
        targetId: String(session.userId),
      });
      return { ok: true as const };
    },
  );
}
