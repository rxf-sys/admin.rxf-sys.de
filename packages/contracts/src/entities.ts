import * as z from 'zod/mini';

/** Core entity kinds every plugin writes into (ADR 0004). */
export const entityKinds = [
  'Host',
  'Guest',
  'NetworkDevice',
  'Client',
  'Service',
  'Backup',
  'Certificate',
  'StoragePool',
] as const;
export type EntityKind = (typeof entityKinds)[number];

export const entityStatuses = ['ok', 'warn', 'crit', 'unknown', 'paused'] as const;
export type EntityStatus = (typeof entityStatuses)[number];

export const entityKind = z.enum(entityKinds);
export const entityStatus = z.enum(entityStatuses);

export const entityResponse = z.object({
  id: z.number(),
  instanceId: z.string(),
  pluginId: z.string(),
  kind: entityKind,
  externalId: z.string(),
  name: z.string(),
  status: entityStatus,
  statusReason: z.nullable(z.string()),
  lastSeen: z.nullable(z.number()),
  attrs: z.record(z.string(), z.unknown()),
  updatedAt: z.number(),
});

export const entityListResponse = z.object({ entities: z.array(entityResponse) });

export const entityQuery = z.object({
  instanceId: z.optional(z.string().check(z.regex(/^[0-9a-f-]{36}$/))),
  kind: z.optional(entityKind),
});

export type EntityResponse = z.infer<typeof entityResponse>;
