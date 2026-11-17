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

export interface ServerPlugin<F extends Record<string, FieldSpec> = Record<string, FieldSpec>> {
  config: ConfigDefinition<F>;
  /** Every peer the instance may contact (ADR 0008, T8); derived from the config only. */
  targets(config: ConfigOf<ConfigDefinition<F>>): Target[];
  /** Requests collectors may send (ADR 0008, T9). Action rules arrive with the action framework. */
  requests: { collect: RequestRule[] };
  test(ctx: PluginContext<ConfigOf<ConfigDefinition<F>>>): Promise<TestResult>;
}

/** Identity helper that keeps the config types connected across the plugin definition. */
export function defineServerPlugin<F extends Record<string, FieldSpec>>(plugin: ServerPlugin<F>): ServerPlugin<F> {
  return plugin;
}
