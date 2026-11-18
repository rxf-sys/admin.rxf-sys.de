import type { FastifyServerOptions } from 'fastify';
import { redactValue, scrubText, serializeError } from './redact.ts';

interface LoggerSettings {
  level?: string;
  /** Destination for tests; production writes JSON to stdout. */
  stream?: NodeJS.WritableStream;
}

interface LoggedRequest {
  method: string;
  url: string;
  ip: string;
  id: string;
}

interface LoggedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
}

/** Callers may log anything under `err`, so nothing about its shape is assumed. */
function serializeLoggedError(err: unknown): LoggedError {
  if (err instanceof Error) {
    const safe = serializeError(err);
    return { ...safe, type: err.name, message: String(safe.message), stack: String(safe.stack ?? '') };
  }
  return { type: typeof err, message: JSON.stringify(redactValue(err)) ?? String(err), stack: '' };
}

/**
 * Logger options for Fastify's built-in pino. Every log object is deep-redacted, message strings are
 * scrubbed, request URLs lose their query string and errors keep only type, code, message and stack.
 */
export function loggerOptions(settings: LoggerSettings = {}): FastifyServerOptions['logger'] {
  return {
    level: settings.level ?? 'info',
    ...(settings.stream ? { stream: settings.stream } : {}),
    formatters: {
      log: (object: Record<string, unknown>) => redactValue(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(
          this,
          args.map((arg) => (typeof arg === 'string' ? scrubText(arg) : arg)) as Parameters<typeof method>,
        );
      },
    },
    serializers: {
      req: (req: LoggedRequest) => ({
        method: req.method,
        url: req.url.split('?')[0],
        ip: req.ip,
        id: req.id,
      }),
      err: serializeLoggedError,
    },
  };
}
