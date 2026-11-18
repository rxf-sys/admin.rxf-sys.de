import type * as z from 'zod/mini';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** GET a JSON endpoint and validate the body against the shared contract (ADR 0002). */
export async function getJson<S extends z.ZodMiniType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(`${path} answered ${res.status}`, res.status);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new ApiError(`${path} sent an unexpected body`, res.status);
  return parsed.data;
}
