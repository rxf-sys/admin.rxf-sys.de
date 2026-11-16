import * as z from 'zod/mini';

export const roles = ['viewer', 'operator', 'admin'] as const;
export const role = z.enum(roles);

/** 3–64 characters from a conservative set, so names stay unambiguous in logs and the audit trail. */
export const username = z.string().check(z.minLength(3), z.maxLength(64), z.regex(/^[a-zA-Z0-9._-]+$/));
/** The policy (length after NFKC, common passwords) is checked on the server; this only bounds the input. */
const password = z.string().check(z.minLength(1), z.maxLength(1024));
const code = z.string().check(z.minLength(1), z.maxLength(64));

export const setupRequest = z.object({ code, username, password });
export const loginRequest = z.object({ username: z.string().check(z.minLength(1), z.maxLength(64)), password });
export const codeRequest = z.object({ code });
export const reauthRequest = z.object({ password, code });

/** `setup_required`: signed in with the password, but a second factor has to be enrolled first (ADR 0005). */
export const mfaState = z.enum(['done', 'pending', 'setup_required']);

export const sessionResponse = z.union([
  z.object({ authenticated: z.literal(false), setupOpen: z.boolean() }),
  z.object({
    authenticated: z.literal(true),
    user: z.object({ id: z.number(), username: z.string(), role }),
    mfa: mfaState,
    csrfToken: z.string(),
    elevatedUntil: z.nullable(z.number()),
  }),
]);

export const loginResponse = z.object({ mfa: mfaState });
export const totpEnrolmentResponse = z.object({ secret: z.string(), uri: z.string() });
export const backupCodesResponse = z.object({ backupCodes: z.array(z.string()) });
export const reauthResponse = z.object({ elevatedUntil: z.number() });

export const sessionListResponse = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      createdAt: z.number(),
      lastSeenAt: z.number(),
      ip: z.nullable(z.string()),
      userAgent: z.nullable(z.string()),
      current: z.boolean(),
    }),
  ),
});

export type Role = z.infer<typeof role>;
export type SessionResponse = z.infer<typeof sessionResponse>;
