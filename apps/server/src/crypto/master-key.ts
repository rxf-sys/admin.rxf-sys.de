import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigError } from '../config.ts';

const KEY_BYTES = 32;

export interface MasterKey {
  /** Short, non-secret identifier stored next to every ciphertext so rotation knows which key sealed it. */
  id: string;
  key: Buffer;
}

export function parseMasterKey(encoded: string, source: string): MasterKey {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encoded.trim()) {
    throw new ConfigError(`${source} must hold ${KEY_BYTES} random bytes as base64 (create one with "rxf keygen")`);
  }
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

/** Loads the master key from the inline development value or the key file; never logs key material. */
export async function loadMasterKey(source: { file: string; inline: string | undefined }): Promise<MasterKey> {
  if (source.inline !== undefined) return parseMasterKey(source.inline, 'RXF_MASTER_KEY');
  let encoded: string;
  try {
    encoded = await readFile(source.file, 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new ConfigError(`master key file ${source.file} is not readable (${reason}); the server needs it to start`);
  }
  return parseMasterKey(encoded, `master key file ${source.file}`);
}

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
