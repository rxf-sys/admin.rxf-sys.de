import type { EntityKind, EntityStatus } from '@rxf/contracts';
import type { ConfigDefinition, ConfigOf, FieldSpec } from './config.ts';
import type { HttpClient, RequestRule, TlsInfo } from './http.ts';
import type { Target } from './targets.ts';

export interface PluginLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

/** What a plugin gets per call. There is no database handle: plugins see only what the core hands over. */
export interface PluginContext<C> {
  config: C;
  /** Decrypted secret fields, alive only for this call. */
  secrets: Readonly<Record<string, string>>;
  http: HttpClient;
  log: PluginLogger;
  now(): number;
  signal: AbortSignal;
}

export type CapabilityStatus = 'ok' | 'missing' | 'excessive' | 'unsupported' | 'failed';

export interface Capability {
  id: string;
  status: CapabilityStatus;
  /** Stable error code for the UI, e.g. `HTTP_STATUS`, `TLS_SELF_SIGNED`. */
  code?: string;
  message?: string;
}

/** Result of `test()`; partial success is allowed (ADR 0003). */
export interface TestResult {
  ok: boolean;
  capabilities: Capability[];
  /** Certificates seen on https targets, shown for confirmation before a pin is stored. */
  tls?: TlsInfo[];
}

/** One entity in a collector snapshot (ADR 0004). `paused` is set by the core only. */
export interface EntityInput {
  kind: EntityKind;
  /** Stable id on the device side, unique per instance and kind. */
  externalId: string;
  name: string;
  status: Exclude<EntityStatus, 'paused'>;
  /** Stable code for the UI, e.g. `HTTP_STATUS`. */
  statusReason?: string;
  attrs?: Record<string, unknown>;
}

/** One measured value for an entity of the same snapshot. */
export interface MetricInput {
  entity: { kind: EntityKind; externalId: string };
  /** Dotted name, e.g. `uptime.response_ms`. */
  name: string;
  unit: string;
  value: number;
  /** Unix ms; defaults to the end of the run. */
  ts?: number;
}

/** A complete snapshot of the entities this collector owns; missing ones turn `unknown` after a grace period. */
export interface CollectResult {
  entities: EntityInput[];
  metrics: MetricInput[];
}

/**
 * A polling collector (ADR 0003). The core schedules it with ±10 % jitter, never runs it in parallel with
 * itself, aborts it via `ctx.signal` after `timeoutMs` and backs off after failures.
 */
export interface Collector<C> {
  id: string;
  /** `activeMs` while someone watches the instance, `backgroundMs` otherwise (ADR 0007). */
  interval: { activeMs: number; backgroundMs: number };
  timeoutMs: number;
  run(ctx: PluginContext<C>): Promise<CollectResult>;
}

export interface ServerPlugin<F extends Record<string, FieldSpec> = Record<string, FieldSpec>> {
  config: ConfigDefinition<F>;
  /** Every peer the instance may contact (ADR 0008, T8); derived from the config only. */
  targets(config: ConfigOf<ConfigDefinition<F>>): Target[];
  /** Opt-in to blocked ranges (loopback, link-local), driven by an admin-only config field. Default: never. */
  allowBlockedAddresses?(config: ConfigOf<ConfigDefinition<F>>): boolean;
  /** Requests collectors may send (ADR 0008, T9). Action rules arrive with the action framework. */
  requests: { collect: RequestRule[] };
  test(ctx: PluginContext<ConfigOf<ConfigDefinition<F>>>): Promise<TestResult>;
  collectors?: Collector<ConfigOf<ConfigDefinition<F>>>[];
  /** Runs of this instance's collectors at the same time; 1 for weak devices (FRITZ!Box). Default: unlimited. */
  maxConcurrent?: number;
}

/** Identity helper that keeps the config types connected across the plugin definition. */
export function defineServerPlugin<F extends Record<string, FieldSpec>>(plugin: ServerPlugin<F>): ServerPlugin<F> {
  return plugin;
}
