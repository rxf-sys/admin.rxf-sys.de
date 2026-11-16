export const REDACTED = '[redacted]';

/** Keys whose values never reach a log line or the audit log, at any depth (ADR 0006). */
const SECRET_KEY =
  /pass(word|phrase)?|secret|token|api[-_]?key|authorization|cookie|private[-_]?key|totp|backup[-_]?codes?|setup[-_]?code/i;

/** Credentials that can show up inside free text, e.g. in an error message from a device. */
const SECRET_TEXT: readonly RegExp[] = [
  /\bcfut_[A-Za-z0-9_-]+/g,
  /\btskey-[A-Za-z0-9-]+/g,
  /PVEAPIToken=[^\s"',;]+/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

export function scrubText(text: string): string {
  return SECRET_TEXT.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}

/**
 * Errors keep only type, code, status and scrubbed message and stack: HTTP clients attach request
 * headers and URLs to their errors, and those must not travel any further.
 */
export function serializeError(error: Error): Record<string, unknown> {
  const { code, statusCode } = error as Error & { code?: unknown; statusCode?: unknown };
  return {
    type: error.name,
    code: typeof code === 'string' ? code : undefined,
    statusCode: typeof statusCode === 'number' ? statusCode : undefined,
    message: scrubText(error.message),
    stack: error.stack ? scrubText(error.stack) : undefined,
  };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep copy of plain data with secret keys replaced and secret-looking text scrubbed. Handles cycles.
 * Class instances other than errors (Fastify requests, dates) pass through untouched for their own
 * log serializers.
 */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value);
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && item !== undefined && item !== null ? REDACTED : redactValue(item, seen);
  }
  return out;
}
