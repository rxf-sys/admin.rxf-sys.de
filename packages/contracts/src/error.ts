import * as z from 'zod/mini';

/** Every API error has this shape (ADR 0002). `code` is stable for the UI, `message` is for humans and logs. */
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.optional(z.record(z.string(), z.unknown())),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponse>;
