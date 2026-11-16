import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.ts';
import { generateMasterKey, loadMasterKey, parseMasterKey } from './master-key.ts';

describe('master key', () => {
  it('generates 32 random bytes as base64', () => {
    const a = generateMasterKey();
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
    expect(generateMasterKey()).not.toBe(a);
  });

  it('derives a stable short id that is not the key', () => {
    const encoded = generateMasterKey();
    const one = parseMasterKey(encoded, 'test');
    expect(one.id).toMatch(/^[0-9a-f]{8}$/);
    expect(parseMasterKey(`${encoded}\n`, 'test').id).toBe(one.id);
    expect(encoded).not.toContain(one.id);
  });

  it.each(['', 'not base64!', Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64')])(
    'rejects %j',
    (value) => {
      expect(() => parseMasterKey(value, 'RXF_MASTER_KEY')).toThrow(ConfigError);
    },
  );

  it('prefers the inline development key', async () => {
    const encoded = generateMasterKey();
    const key = await loadMasterKey({ file: '/does/not/exist', inline: encoded });
    expect(key.key.toString('base64')).toBe(encoded);
  });

  it('reads the key file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rxf-key-'));
    const encoded = generateMasterKey();
    await writeFile(join(dir, 'key'), `${encoded}\n`, { mode: 0o400 });
    const key = await loadMasterKey({ file: join(dir, 'key'), inline: undefined });
    expect(key.key.toString('base64')).toBe(encoded);
  });

  it('explains a missing key file without leaking anything', async () => {
    await expect(loadMasterKey({ file: '/does/not/exist', inline: undefined })).rejects.toThrow(
      /not readable \(ENOENT\)/,
    );
  });
});
