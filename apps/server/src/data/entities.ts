import { type EntityKind, type EntityResponse, entityKind } from '@rxf/contracts';
import type { CollectResult } from '@rxf/sdk';
import { and, eq, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import * as z from 'zod/mini';
import type { DatabaseHandle } from '../db/database.ts';
import { entities, pluginInstances } from '../db/schema.ts';
import { writeMetrics } from './metrics.ts';

const MAX_ATTRS_BYTES = 16_384;
const MAX_ENTITIES = 5_000;
const MAX_METRICS = 20_000;

const entityInput = z.object({
  kind: entityKind,
  externalId: z.string().check(z.minLength(1), z.maxLength(200)),
  name: z.string().check(z.minLength(1), z.maxLength(200)),
  // `paused` belongs to the core (ADR 0003).
  status: z.enum(['ok', 'warn', 'crit', 'unknown']),
  statusReason: z.optional(z.string().check(z.regex(/^[A-Z0-9_]{1,64}$/))),
  attrs: z.optional(z.record(z.string(), z.unknown())),
});

const metricInput = z.object({
  entity: z.object({ kind: entityKind, externalId: z.string() }),
  name: z.string().check(z.regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/), z.maxLength(64)),
  unit: z.string().check(z.maxLength(16)),
  value: z.number().check(z.refine(Number.isFinite, 'finite')),
  ts: z.optional(z.number().check(z.int())),
});

const collectResult = z.object({
  entities: z.array(entityInput).check(z.maxLength(MAX_ENTITIES)),
  metrics: z.array(metricInput).check(z.maxLength(MAX_METRICS)),
});

/** A collector returned something the core does not accept; counts as a failed run. */
export class InvalidSnapshotError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid collector snapshot: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'InvalidSnapshotError';
    this.issues = issues;
  }
}

const keyOf = (kind: string, externalId: string) => `${kind}\u0000${externalId}`;

/** Checks shape, sizes and references of a snapshot before anything is written (ADR 0004). */
function validate(result: unknown): CollectResult {
  const parsed = collectResult.safeParse(result);
  if (!parsed.success) {
    // Paths only; values come from devices and may hold anything.
    throw new InvalidSnapshotError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [i, entity] of parsed.data.entities.entries()) {
    const key = keyOf(entity.kind, entity.externalId);
    if (seen.has(key)) issues.push(`entities.${i}: duplicate ${entity.kind} ${entity.externalId}`);
    seen.add(key);
    if (entity.attrs && JSON.stringify(entity.attrs).length > MAX_ATTRS_BYTES) {
      issues.push(`entities.${i}.attrs: larger than ${MAX_ATTRS_BYTES} bytes`);
    }
  }
  for (const [i, metric] of parsed.data.metrics.entries()) {
    if (!seen.has(keyOf(metric.entity.kind, metric.entity.externalId))) {
      issues.push(`metrics.${i}.entity: not part of this snapshot`);
    }
  }
  if (issues.length > 0) throw new InvalidSnapshotError(issues);
  return parsed.data as CollectResult;
}

export interface SnapshotOutcome {
  kinds: EntityKind[];
  seriesIds: number[];
}

export class EntityStore {
  readonly #handle: DatabaseHandle;

  constructor(handle: DatabaseHandle) {
    this.#handle = handle;
  }

  /**
   * Writes one collector run in a single transaction: upserts its entities, marks entities of the same
   * collector that have been missing longer than `graceMs` as `unknown` and appends the metrics.
   */
  applySnapshot(instanceId: string, collectorId: string, raw: unknown, now: number, graceMs: number): SnapshotOutcome {
    const result = validate(raw);
    const db = this.#handle.db;
    return db.transaction(() => {
      const ids = new Map<string, number>();
      for (const entity of result.entities) {
        const values = {
          collectorId,
          name: entity.name,
          status: entity.status,
          statusReason: entity.statusReason ?? null,
          lastSeen: now,
          attrsJson: JSON.stringify(entity.attrs ?? {}),
          updatedAt: now,
        };
        const row = db
          .insert(entities)
          .values({ instanceId, kind: entity.kind, externalId: entity.externalId, ...values })
          .onConflictDoUpdate({ target: [entities.instanceId, entities.kind, entities.externalId], set: values })
          .returning({ id: entities.id })
          .get();
        ids.set(keyOf(entity.kind, entity.externalId), row.id);
      }

      const present = [...ids.values()];
      const missing = db
        .update(entities)
        .set({ status: 'unknown', statusReason: 'MISSING', updatedAt: now })
        .where(
          and(
            eq(entities.instanceId, instanceId),
            eq(entities.collectorId, collectorId),
            ne(entities.status, 'unknown'),
            or(lt(entities.lastSeen, now - graceMs), sql`${entities.lastSeen} IS NULL`),
            present.length > 0 ? notInArray(entities.id, present) : undefined,
          ),
        )
        .returning({ kind: entities.kind })
        .all();

      const seriesIds = writeMetrics(
        this.#handle.sqlite,
        result.metrics.map((metric) => ({
          entityId: ids.get(keyOf(metric.entity.kind, metric.entity.externalId)) as number,
          name: metric.name,
          unit: metric.unit,
          value: metric.value,
          ts: metric.ts ?? now,
        })),
      );
      const kinds = new Set<EntityKind>([...result.entities.map((e) => e.kind), ...missing.map((m) => m.kind)]);
      return { kinds: [...kinds], seriesIds };
    });
  }

  /** Paused instances keep their entities, shown as `paused` (ADR 0003). Returns the affected kinds. */
  markPaused(instanceId: string, now: number): EntityKind[] {
    const rows = this.#handle.db
      .update(entities)
      .set({ status: 'paused', statusReason: null, updatedAt: now })
      .where(eq(entities.instanceId, instanceId))
      .returning({ kind: entities.kind })
      .all();
    return [...new Set(rows.map((row) => row.kind))];
  }

  list(filter: { instanceId?: string | undefined; kind?: EntityKind | undefined }): EntityResponse[] {
    const rows = this.#handle.db
      .select({ entity: entities, pluginId: pluginInstances.pluginId })
      .from(entities)
      .innerJoin(pluginInstances, eq(pluginInstances.id, entities.instanceId))
      .where(
        and(
          filter.instanceId ? eq(entities.instanceId, filter.instanceId) : undefined,
          filter.kind ? eq(entities.kind, filter.kind) : undefined,
        ),
      )
      .orderBy(entities.instanceId, entities.kind, entities.name)
      .all();
    return rows.map(({ entity, pluginId }) => ({
      id: entity.id,
      instanceId: entity.instanceId,
      pluginId,
      kind: entity.kind,
      externalId: entity.externalId,
      name: entity.name,
      status: entity.status,
      statusReason: entity.statusReason,
      lastSeen: entity.lastSeen,
      attrs: JSON.parse(entity.attrsJson) as Record<string, unknown>,
      updatedAt: entity.updatedAt,
    }));
  }
}
