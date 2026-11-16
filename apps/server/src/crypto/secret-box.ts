import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKey } from './master-key.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Binds a ciphertext to where it is stored, so it cannot be copied to another instance or field (ADR 0006). */
export interface SecretLocation {
  instanceId: string;
  slot: string;
  field: string;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

function associatedData(location: SecretLocation, keyId: string): Buffer {
  for (const part of [location.instanceId, location.slot, location.field]) {
    if (part === '' || part.includes('|')) throw new Error('secret location parts must be non-empty and free of "|"');
  }
  return Buffer.from(`${location.instanceId}|${location.slot}|${location.field}|${keyId}`, 'utf8');
}

export function sealSecret(key: MasterKey, location: SecretLocation, plaintext: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(location, key.id));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyId: key.id };
}

/** Decrypts with the key that sealed the value. Any tampering, wrong key or wrong location fails. */
export function openSecret(keys: readonly MasterKey[], location: SecretLocation, sealed: SealedSecret): string {
  const key = keys.find((k) => k.id === sealed.keyId);
  if (!key) throw new SecretDecryptError(`no master key with id ${sealed.keyId} is loaded`);
  if (sealed.tag.length !== TAG_BYTES) throw new SecretDecryptError('authentication tag has the wrong length');
  const decipher = createDecipheriv(ALGORITHM, key.key, sealed.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(location, sealed.keyId));
  decipher.setAuthTag(sealed.tag);
  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // The cipher error carries no detail beyond "unable to authenticate"; it never contains the plaintext.
    throw new SecretDecryptError(
      `secret ${location.instanceId}/${location.slot}/${location.field} failed authentication`,
    );
  }
}
