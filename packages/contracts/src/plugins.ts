import * as z from 'zod/mini';
import { instanceHealth } from './stream.ts';

const localized = z.object({ de: z.string(), en: z.string() });

export const pluginSummary = z.object({
  id: z.string(),
  name: localized,
  description: localized,
  category: z.string(),
  icon: z.string(),
  version: z.string(),
  multiInstance: z.boolean(),
});

export const catalogResponse = z.object({ plugins: z.array(pluginSummary) });

export const instanceStatus = z.enum(['draft', 'active', 'paused']);

/** Secret fields appear only as "set / last changed", never with their value (ADR 0006). */
export const instanceResponse = z.object({
  id: z.string(),
  pluginId: z.string(),
  name: z.string(),
  status: instanceStatus,
  health: instanceHealth,
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.object({ set: z.boolean(), updatedAt: z.nullable(z.number()) })),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const instanceListResponse = z.object({ instances: z.array(instanceResponse) });

const instanceName = z.string().check(z.minLength(1), z.maxLength(80));

export const createInstanceRequest = z.object({
  pluginId: z.string().check(z.regex(/^[a-z0-9-]{1,40}$/)),
  name: instanceName,
  config: z.record(z.string(), z.unknown()),
});

/** An empty or missing secret field leaves the stored secret unchanged. */
export const updateInstanceRequest = z.object({
  name: z.optional(instanceName),
  config: z.optional(z.record(z.string(), z.unknown())),
});

export const testResultResponse = z.object({
  ok: z.boolean(),
  capabilities: z.array(
    z.object({ id: z.string(), status: z.string(), code: z.optional(z.string()), message: z.optional(z.string()) }),
  ),
  tls: z.optional(
    z.array(
      z.object({
        origin: z.string(),
        leafSha256: z.string(),
        spkiSha256: z.string(),
        subject: z.string(),
        issuer: z.string(),
        subjectAltName: z.nullable(z.string()),
        validTo: z.string(),
        trusted: z.boolean(),
      }),
    ),
  ),
});

export type InstanceResponse = z.infer<typeof instanceResponse>;
export type TestResultResponse = z.infer<typeof testResultResponse>;
