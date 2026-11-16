import { describe, expect, it } from 'vitest';
import { generateMasterKey, parseMasterKey } from './master-key.ts';
import { openSecret, SecretDecryptError, type SecretLocation, sealSecret } from './secret-box.ts';

const key = parseMasterKey(generateMasterKey(), 'test');
const other = parseMasterKey(generateMasterKey(), 'test');
const at: SecretLocation = { instanceId: '0c6b6c1e-1f6a-4b8e-9d37-6a3e1f1f2f10', slot: 'config', field: 'tokenSecret' };
const plaintext = 'PVEAPIToken=rxf@pve!monitor=7c1f…ünï';

describe('secret box', () => {
  it('round-trips unicode plaintext', () => {
    const sealed = sealSecret(key, at, plaintext);
    expect(sealed.keyId).toBe(key.id);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('PVEAPIToken');
    expect(openSecret([key], at, sealed)).toBe(plaintext);
  });

  it('uses a fresh IV every time', () => {
    const a = sealSecret(key, at, plaintext);
    const b = sealSecret(key, at, plaintext);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('finds the sealing key among several (rotation)', () => {
    const sealed = sealSecret(key, at, plaintext);
    expect(openSecret([other, key], at, sealed)).toBe(plaintext);
  });

  it('fails when no loaded key matches', () => {
    expect(() => openSecret([other], at, sealSecret(key, at, plaintext))).toThrow(/no master key with id/);
  });

  it.each([
    ['another instance', { ...at, instanceId: '7d1d3c51-0000-4000-8000-000000000000' }],
    ['another slot', { ...at, slot: 'action' }],
    ['another field', { ...at, field: 'password' }],
  ])('refuses a ciphertext copied to %s', (_, location) => {
    expect(() => openSecret([key], location, sealSecret(key, at, plaintext))).toThrow(SecretDecryptError);
  });

  it('detects a modified ciphertext or tag', () => {
    const sealed = sealSecret(key, at, plaintext);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => openSecret([key], at, { ...sealed, ciphertext: flipped })).toThrow(SecretDecryptError);
    expect(() => openSecret([key], at, { ...sealed, tag: Buffer.alloc(16) })).toThrow(SecretDecryptError);
    expect(() => openSecret([key], at, { ...sealed, tag: sealed.tag.subarray(0, 8) })).toThrow(/wrong length/);
  });

  it('keeps the plaintext out of the error message', () => {
    const sealed = sealSecret(key, at, plaintext);
    try {
      openSecret([key], { ...at, field: 'other' }, sealed);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('PVEAPIToken');
    }
  });

  it.each([
    { ...at, slot: '' },
    { ...at, field: 'a|b' },
  ])('rejects an ambiguous location %j', (location) => {
    expect(() => sealSecret(key, location, plaintext)).toThrow(/free of "\|"/);
  });
});
