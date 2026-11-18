import { errorResponse } from '@rxf/contracts';
import * as z from 'zod/mini';

export class ApiError extends Error {
  readonly status: number;
  /** Stable code from the error envelope (ADR 0002), e.g. `INVALID_CODE`; `HTTP_<status>` without one. */
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, code = `HTTP_${status}`, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The synchronizer token of the current session (ADR 0005); set whenever the session is loaded. */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function parse<S extends z.ZodMiniType>(res: Response, path: string, schema: S): Promise<z.infer<S>> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = errorResponse.safeParse(body);
    if (envelope.success) {
      const { code, message, details } = envelope.data.error;
      throw new ApiError(message, res.status, code, details ?? {});
    }
    throw new ApiError(`${path} answered ${res.status}`, res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(`${path} sent an unexpected body`, res.status, 'UNEXPECTED_BODY');
  return parsed.data;
}

/** GET a JSON endpoint and validate the body against the shared contract (ADR 0002). */
export async function getJson<S extends z.ZodMiniType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  return parse(res, path, schema);
}

/** Sends a state-changing request with the CSRF token and validates the answer. */
export async function sendJson<S extends z.ZodMiniType>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parse(res, path, schema);
}

export const okResponse = z.object({ ok: z.literal(true) });
