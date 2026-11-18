import * as z from 'zod/mini';
import { entityKind } from './entities.ts';

/** Collector health of an instance, as shown next to its status (ADR 0003, 0007). */
export const instanceHealth = z.enum(['idle', 'ok', 'failing', 'breaker-open']);
export type InstanceHealth = z.infer<typeof instanceHealth>;

/**
 * Events on `GET /api/stream` (ADR 0007). They only say what changed; the browser fetches data through the
 * normal API, so role checks live in one place.
 */
export const streamEventData = {
  hello: z.object({ connectionId: z.string() }),
  entities: z.object({ instanceId: z.string(), kinds: z.array(entityKind), version: z.number() }),
  metrics: z.object({ seriesIds: z.array(z.number()), until: z.number() }),
  instance: z.object({
    instanceId: z.string(),
    status: z.enum(['draft', 'active', 'paused', 'deleted']),
    health: instanceHealth,
  }),
  session: z.object({ revoked: z.literal(true) }),
  resync: z.object({}),
};

export type StreamEventType = keyof typeof streamEventData;
export type StreamEventData<T extends StreamEventType> = z.infer<(typeof streamEventData)[T]>;

/** The instances whose widgets are visible in one tab; drives active vs. background polling. */
export const watchRequest = z.object({
  connectionId: z.string().check(z.regex(/^[A-Za-z0-9_-]{22}$/)),
  instanceIds: z.array(z.string().check(z.regex(/^[0-9a-f-]{36}$/))).check(z.maxLength(200)),
});
