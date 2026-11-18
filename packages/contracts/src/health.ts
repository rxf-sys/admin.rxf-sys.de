import * as z from 'zod/mini';

/** Response of `GET /api/healthz`: the server process is up and answers requests. */
export const healthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponse>;
