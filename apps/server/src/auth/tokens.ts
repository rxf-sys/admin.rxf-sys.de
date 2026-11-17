import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 256 bits of randomness, URL-safe; used for session and CSRF tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniform RFC 4648 base32 characters, 5 bits each (256 is a multiple of 32, so masking has no bias). */
export function randomBase32(length: number): string {
  let out = '';
  for (const byte of randomBytes(length)) out += BASE32[byte & 31];
  return out;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Codes are shown in groups ("ABCDE-FGHIJ"); users may type them with spaces, dashes or in lower case. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export function groupCode(code: string, size = 5): string {
  return code.match(new RegExp(`.{1,${size}}`, 'g'))?.join('-') ?? code;
}
