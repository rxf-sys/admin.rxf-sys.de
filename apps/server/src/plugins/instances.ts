import { randomUUID } from 'node:crypto';
import type { InstanceHealth, InstanceResponse } from '@rxf/contracts';
import { adminOnlyFieldNames, type ServerPlugin, secretFieldNames } from '@rxf/sdk';
import { and, eq } from 'drizzle-orm';
import type { MasterKey } from '../crypto/master-key.ts';
import { openSecret, sealSecret } from '../crypto/secret-box.ts';
import type { Db } from '../db/database.ts';
import { pluginInstances, secrets } from '../db/schema.ts';
import { AppError } from '../http/errors.ts';

export type InstanceRow = typeof pluginInstances.$inferSelect;

const SLOT = 'config';

/** Splits submitted config values into plain fields and secret fields. */
function splitConfig(plugin: ServerPlugin, config: Record<string, unknown>) {
  const secretNames = new Set(secretFieldNames(plugin.config));
  const plain: Record<string, unknown> = {};
  const secretValues: Record<string, string> = {};
  for (const [name, value] of Object.entries(config)) {
    if (!secretNames.has(name)) plain[name] = value;
    else if (typeof value === 'string' && value !== '') secretValues[name] = value;
  }
  return { plain, secretValues, secretNames };
}

function invalidConfig(issues: { path: PropertyKey[]; message: string }[]): AppError {
  // Paths and messages only; values could be secrets.
  const details = {
    issues: issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  };
  return new AppError(400, 'INVALID_CONFIG', 'The configuration does not match the plugin schema', details);
}

export class InstanceStore {
  readonly #db: Db;
  readonly #key: MasterKey;
  readonly #now: () => number;

  constructor(db: Db, key: MasterKey, now: () => number) {
    this.#db = db;
    this.#key = key;
    this.#now = now;
  }

  get(id: string): InstanceRow {
    const row = this.#db.select().from(pluginInstances).where(eq(pluginInstances.id, id)).get();
    if (!row) throw new AppError(404, 'INSTANCE_NOT_FOUND', 'There is no such instance');
    return row;
  }

  list(): InstanceRow[] {
    return this.#db.select().from(pluginInstances).all();
  }

  countFor(pluginId: string): number {
    return this.#db.select().from(pluginInstances).where(eq(pluginInstances.pluginId, pluginId)).all().length;
  }

  #storedSecrets(instanceId: string): Record<string, string> {
    const out: Record<string, string> = {};
    const rows = this.#db
      .select()
      .from(secrets)
      .where(and(eq(secrets.instanceId, instanceId), eq(secrets.slot, SLOT)))
      .all();
    for (const row of rows) out[row.field] = openSecret([this.#key], { instanceId, slot: SLOT, field: row.field }, row);
    return out;
  }

  #validate(plugin: ServerPlugin, merged: Record<string, unknown>): void {
    const parsed = plugin.config.schema.safeParse(merged);
    if (!parsed.success) throw invalidConfig(parsed.error.issues);
  }

  #writeSecrets(instanceId: string, values: Record<string, string>, t: number): void {
    for (const [field, value] of Object.entries(values)) {
      const sealed = sealSecret(this.#key, { instanceId, slot: SLOT, field }, value);
      const row = { ...sealed, updatedAt: t };
      this.#db
        .insert(secrets)
        .values({ instanceId, slot: SLOT, field, ...row })
        .onConflictDoUpdate({ target: [secrets.instanceId, secrets.slot, secrets.field], set: row })
        .run();
    }
  }

  /** New instances start as drafts: secrets are already encrypted, nothing runs yet (ADR 0003). */
  create(
    plugin: ServerPlugin,
    input: { pluginId: string; name: string; config: Record<string, unknown> },
    userId: number,
  ): InstanceRow {
    const { plain, secretValues } = splitConfig(plugin, input.config);
    this.#validate(plugin, { ...plain, ...secretValues });
    const id = randomUUID();
    const t = this.#now();
    this.#db.transaction(() => {
      this.#db
        .insert(pluginInstances)
        .values({
          id,
          pluginId: input.pluginId,
          name: input.name,
          status: 'draft',
          configJson: JSON.stringify(plain),
          createdBy: userId,
          createdAt: t,
          updatedAt: t,
        })
        .run();
      this.#writeSecrets(id, secretValues, t);
    });
    return this.get(id);
  }

  /** Which fields an update touches that need a re-authentication: targets and secrets (ADR 0008). */
  sensitiveFieldsTouched(
    plugin: ServerPlugin,
    row: InstanceRow,
    config: Record<string, unknown> | undefined,
  ): string[] {
    if (!config) return [];
    const current = JSON.parse(row.configJson) as Record<string, unknown>;
    const { secretValues } = splitConfig(plugin, config);
    const adminOnly = adminOnlyFieldNames(plugin.config).filter(
      (name) => name in config && JSON.stringify(config[name]) !== JSON.stringify(current[name]),
    );
    return [...adminOnly, ...Object.keys(secretValues)];
  }

  update(
    plugin: ServerPlugin,
    row: InstanceRow,
    input: { name?: string; config?: Record<string, unknown> },
  ): InstanceRow {
    const t = this.#now();
    let configJson = row.configJson;
    let secretValues: Record<string, string> = {};
    if (input.config) {
      const split = splitConfig(plugin, input.config);
      const plain = { ...(JSON.parse(row.configJson) as Record<string, unknown>), ...split.plain };
      secretValues = split.secretValues;
      this.#validate(plugin, { ...plain, ...this.#storedSecrets(row.id), ...secretValues });
      configJson = JSON.stringify(plain);
    }
    this.#db.transaction(() => {
      this.#db
        .update(pluginInstances)
        .set({ name: input.name ?? row.name, configJson, updatedAt: t })
        .where(eq(pluginInstances.id, row.id))
        .run();
      this.#writeSecrets(row.id, secretValues, t);
    });
    return this.get(row.id);
  }

  setStatus(row: InstanceRow, status: InstanceRow['status']): InstanceRow {
    this.#db
      .update(pluginInstances)
      .set({ status, updatedAt: this.#now() })
      .where(eq(pluginInstances.id, row.id))
      .run();
    return this.get(row.id);
  }

  /** Removes the instance; secrets go with it through the foreign key (ADR 0004). */
  delete(row: InstanceRow): void {
    this.#db.delete(pluginInstances).where(eq(pluginInstances.id, row.id)).run();
  }

  /** Full config including decrypted secrets, for the plugin call that needs it. */
  runtimeConfig(row: InstanceRow): { config: Record<string, unknown>; secretValues: Record<string, string> } {
    const secretValues = this.#storedSecrets(row.id);
    return { config: { ...(JSON.parse(row.configJson) as Record<string, unknown>), ...secretValues }, secretValues };
  }

  view(plugin: ServerPlugin | null, row: InstanceRow, health: InstanceHealth): InstanceResponse {
    const stored = this.#db
      .select({ field: secrets.field, updatedAt: secrets.updatedAt })
      .from(secrets)
      .where(and(eq(secrets.instanceId, row.id), eq(secrets.slot, SLOT)))
      .all();
    const names = plugin ? secretFieldNames(plugin.config) : stored.map((s) => s.field);
    const secretState: InstanceResponse['secrets'] = {};
    for (const name of names) {
      const entry = stored.find((s) => s.field === name);
      secretState[name] = { set: entry !== undefined, updatedAt: entry?.updatedAt ?? null };
    }
    return {
      id: row.id,
      pluginId: row.pluginId,
      name: row.name,
      status: row.status,
      health,
      config: JSON.parse(row.configJson) as Record<string, unknown>,
      secrets: secretState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
