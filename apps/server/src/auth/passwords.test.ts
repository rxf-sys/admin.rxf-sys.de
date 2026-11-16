import { describe, expect, it } from 'vitest';
import { checkPassword, hashPassword, loadCommonPasswords, verifyPassword } from './passwords.ts';

const common = new Set(['password', 'letmein']);

describe('checkPassword', () => {
  it.each([
    ['short1234!', 'too_short'],
    ['x'.repeat(129), 'too_long'],
    ['passwordpassword', 'too_common'],
    ['Password1234!!', 'too_common'],
    ['LETMEIN-2026-2026', 'too_common'],
    ['abcabcabcabc', 'too_common'],
    ['aaaaaaaaaaaaaaaa', 'too_common'],
  ])('rejects %j as %s', (password, problem) => {
    expect(checkPassword(password, common)).toBe(problem);
  });

  it.each(['correct horse battery', 'Wörterbuch-Kaffee-42', 'ein langer Satz ohne Regeln'])(
    'accepts %j',
    (password) => {
      expect(checkPassword(password, common)).toBeNull();
    },
  );

  it('counts code points after NFKC, not UTF-16 units', () => {
    expect(checkPassword('😀'.repeat(11), common)).toBe('too_short');
    expect(checkPassword('😀😁😂🤣😃😄😅😆😉😊😋😎', common)).toBeNull();
  });

  it('ships the SecLists list', () => {
    const list = loadCommonPasswords();
    expect(list.size).toBeGreaterThan(9_000);
    expect(list.has('123456')).toBe(true);
  });
});

describe('password hashing', () => {
  it('uses Argon2id with the OWASP minimum parameters', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterY')).toBe(false);
  });

  it('treats NFKC-equivalent input as the same password', async () => {
    const hash = await hashPassword('Ａｂｃｄｅｆｇｈｉｊｋｌ');
    expect(await verifyPassword(hash, 'Abcdefghijkl')).toBe(true);
  });

  it('answers false without a stored hash, after doing the same work', async () => {
    expect(await verifyPassword(null, 'anything at all')).toBe(false);
  });
});
