import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash, verify } from '@node-rs/argon2';
import { randomToken } from './tokens.ts';

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

/** OWASP minimum for Argon2id (ADR 0005). Argon2id is the library default; a test pins the hash prefix. */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** SecLists "10k-most-common" (MIT, see assets/LICENSE-seclists.txt), checked offline. */
const COMMON_PASSWORDS_FILE = fileURLToPath(new URL('../../assets/common-passwords.txt', import.meta.url));

export function loadCommonPasswords(file = COMMON_PASSWORDS_FILE): ReadonlySet<string> {
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
}

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common';

/** The shortest unit the value is a repetition of ("abcabc" → "abc"), or the value itself. */
function repeatedUnit(value: string): string {
  for (let size = 1; size <= value.length / 2; size++) {
    if (value.length % size === 0 && value.slice(0, size).repeat(value.length / size) === value) {
      return value.slice(0, size);
    }
  }
  return value;
}

/**
 * Length 12–128 code points after NFKC, no composition rules. With a 12-character minimum almost no list
 * entry matches as a whole, so the check also looks at the password without trailing non-letters
 * ("Password1234!!" → "password") and rejects repetitions of a short pattern or of a common password.
 */
export function checkPassword(password: string, common: ReadonlySet<string>): PasswordProblem | null {
  const normalized = password.normalize('NFKC');
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  const lower = normalized.toLowerCase();
  const core = lower.replace(/[^\p{L}]+$/u, '');
  const unit = repeatedUnit(lower);
  const repeated = unit !== lower && (unit.length <= 4 || common.has(unit));
  if (common.has(lower) || (core !== '' && common.has(core)) || repeated) return 'too_common';
  return null;
}

/** At most two Argon2 computations at once, so a burst of logins stays inside the memory budget (ADR 0005). */
class Semaphore {
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

const limiter = new Semaphore(2);
let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return limiter.run(() => hash(password.normalize('NFKC'), ARGON2));
}

/**
 * Verifies against the stored hash, or against a throwaway hash when there is none, so unknown,
 * disabled and wrong accounts take the same time (lesson #6).
 */
export async function verifyPassword(storedHash: string | null, password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomToken());
  const target = storedHash ?? (await dummyHash);
  const ok = await limiter.run(() => verify(target, password.normalize('NFKC')));
  return ok && storedHash !== null;
}
