import { passkeyOptionsResponse, passkeyRegisterResponse, reauthResponse } from '@rxf/contracts';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import * as z from 'zod/mini';
import { ApiError, sendJson } from './api.ts';

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

/** The browser dialog was closed or timed out, or the authenticator is already registered. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const code = (error as { code?: string }).code;
    if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
      throw new ApiError('passkey already registered', 0, 'PASSKEY_KNOWN');
    }
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new ApiError('passkey ceremony cancelled', 0, 'PASSKEY_CANCELLED');
    }
    throw error;
  }
}

/** Registers a passkey for the signed-in account; returns backup codes when it is the first factor. */
export async function registerPasskey(name: string) {
  const { options } = await sendJson('POST', '/api/auth/passkeys/register/options', passkeyOptionsResponse);
  const response = await ceremony(() => startRegistration({ optionsJSON: options as never }));
  return sendJson('POST', '/api/auth/passkeys/register', passkeyRegisterResponse, { response, name });
}

/** Passwordless sign-in; also completes a pending second factor (it starts a new session). */
export async function signInWithPasskey() {
  const { options } = await sendJson('POST', '/api/auth/passkeys/login/options', passkeyOptionsResponse);
  const response = await ceremony(() => startAuthentication({ optionsJSON: options as never }));
  return sendJson('POST', '/api/auth/passkeys/login', z.object({ mfa: z.literal('done') }), { response });
}

export async function reauthWithPasskey() {
  const { options } = await sendJson('POST', '/api/auth/reauth/passkey/options', passkeyOptionsResponse);
  const response = await ceremony(() => startAuthentication({ optionsJSON: options as never }));
  return sendJson('POST', '/api/auth/reauth/passkey', reauthResponse, { response });
}
