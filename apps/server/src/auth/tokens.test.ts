import { describe, expect, it } from 'vitest';
import { groupCode, normalizeCode, randomBase32, randomToken, safeEqual, sha256 } from './tokens.ts';

describe('tokens', () => {
  it('makes 256-bit url-safe tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('makes base32 codes of the requested length', () => {
    expect(randomBase32(20)).toMatch(/^[A-Z2-7]{20}$/);
  });

  it('hashes with sha256', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('groups codes and accepts them back with spaces, dashes and lower case', () => {
    expect(groupCode('ABCDEFGHIJKLMNOPQRST')).toBe('ABCDE-FGHIJ-KLMNO-PQRST');
    expect(normalizeCode(' abcde-fghij ')).toBe('ABCDEFGHIJ');
  });
});
