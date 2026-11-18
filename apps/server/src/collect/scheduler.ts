import type { InstanceHealth } from '@rxf/contracts';
import { type Collector, createHttpClient, type HttpClient, PluginHttpError, type ServerPlugin } from '@rxf/sdk';
import type { FastifyBaseLogger } from 'fastify';
import { type EntityStore, InvalidSnapshotError } from '../data/entities.ts';
import type { PluginHost } from '../plugins/host.ts';
import type { InstanceRow, InstanceStore } from '../plugins/instances.ts';
import type { EventBus } from '../stream/bus.ts';
import { Semaphore } from '../util/semaphore.ts';

/** Consecutive failed runs after which the instance's circuit opens (ADR 0003). */
export const BREAKER_THRESHOLD = 3;
const BREAKER_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** After the last viewer leaves, collectors stay on the active interval this long (ADR 0007). */
export const WATCH_GRACE_MS = 60_000;
const HTTP_TIMEOUT_CAP_MS = 60_000;
const DEFAULT_GLOBAL_CONCURRENCY = 8;

type AnyCollector = Collector<unknown>;

interface CollectorState {
  def: AnyCollector;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

interface Runtime {
  row: InstanceRow;
  plugin: ServerPlugin;
  config: unknown;
  secrets: Readonly<Record<string, string>>;
  http: HttpClient;
  controller: AbortController;
  limiter: Semaphore | null;
  collectors: CollectorState[];
  failures: number;
  /** Set while the circuit is open; the first run after it is the half-open trial. */
  openUntil: number | null;
  breakerMs: number;
  trialRunning: boolean;
  health: InstanceHealth;
}

export interface SchedulerDeps {
  host: PluginHost;
  instances: InstanceStore;
  entities: EntityStore;
  bus: EventBus;
  log: FastifyBaseLogger;
  now: () => number;
  /** False in tests that do not exercise collectors: start() then does nothing. */
  enabled: boolean;
  globalConcurrency?: number;
  random?: () => number;
}

/** ±10 % so instances with the same interval do not fire in lockstep (ADR 0003). */
function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.9 + random() * 0.2));
}

/** Only codes and short messages reach the log; device answers and secrets never do (ADR 0006). */
function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof PluginHttpError) return { code: error.code, message: error.message };
  if (error instanceof InvalidSnapshotError) return { code: 'INVALID_SNAPSHOT', message: error.message };
  if (error instanceof Error && error.name === 'CollectorTimeout') return { code: 'TIMEOUT', message: error.message };
  return { code: 'COLLECTOR_FAILED', message: error instanceof Error ? error.name : 'non-error thrown' };
}

/**
 * Runs the collectors of active instances (ADR 0003, 0007): jittered intervals, timeout, exponential backoff,
 * a circuit breaker per instance, a concurrency limit per instance and globally, and active vs. background
 * intervals depending on whether someone watches. Runs of one collector never overlap: the next run is only
 * scheduled when the previous one has finished.
 */
export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #global: Semaphore;
  readonly #random: () => number;
  readonly #runtimes = new Map<string, Runtime>();
  readonly #watchers = new Map<string, ReadonlySet<string>>();
  readonly #lastWatched = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#global = new Semaphore(deps.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY);
    this.#random = deps.random ?? Math.random;
  }

  health(instanceId: string): InstanceHealth {
    return this.#runtimes.get(instanceId)?.health ?? 'idle';
  }

  isRunning(instanceId: string): boolean {
    return this.#runtimes.has(instanceId);
  }

  async startAll(): Promise<void> {
    for (const row of this.#deps.instances.list()) {
      if (row.status !== 'active') continue;
      try {
        await this.start(row);
      } catch (error) {
        this.#deps.log.error({ instanceId: row.id, ...describeFailure(error) }, 'instance could not start');
      }
    }
  }

  /** Loads the plugin and schedules its collectors; the first run follows right away. */
  async start(row: InstanceRow): Promise<void> {
    if (!this.#deps.enabled || this.#runtimes.has(row.id)) return;
    const plugin = await this.#deps.host.load(row.pluginId);
    const collectors = (plugin.collectors ?? []) as AnyCollector[];
    if (collectors.length === 0) return;
    const { config: rawConfig, secretValues } = this.#deps.instances.runtimeConfig(row);
    const config = plugin.config.schema.parse(rawConfig);
    const timeoutMs = Math.min(Math.max(...collectors.map((c) => c.timeoutMs)), HTTP_TIMEOUT_CAP_MS);
    const runtime: Runtime = {
      row,
      plugin,
      config,
      secrets: secretValues,
      http: createHttpClient({
        targets: plugin.targets(config),
        requests: plugin.requests.collect,
        timeoutMs,
        allowBlockedAddresses: plugin.allowBlockedAddresses?.(config) ?? false,
      }),
      controller: new AbortController(),
      limiter: plugin.maxConcurrent ? new Semaphore(plugin.maxConcurrent) : null,
      collectors: collectors.map((def) => ({ def, timer: null, running: false })),
      failures: 0,
      openUntil: null,
      breakerMs: BREAKER_FIRST_MS,
      trialRunning: false,
      health: 'ok',
    };
    this.#runtimes.set(row.id, runtime);
    for (const state of runtime.collectors) this.#schedule(runtime, state, 0);
    this.#publishInstance(runtime);
  }

  /** Aborts running collectors, cancels timers and drops decrypted secrets from memory. */
  async stop(instanceId: string): Promise<void> {
    const runtime = this.#runtimes.get(instanceId);
    if (!runtime) return;
    this.#runtimes.delete(instanceId);
    runtime.controller.abort();
    for (const state of runtime.collectors) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
    await runtime.http.close();
  }

  async restart(row: InstanceRow): Promise<void> {
    await this.stop(row.id);
    await this.start(row);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((id) => this.stop(id)));
  }

  /** Replaces the set of instances one stream connection watches (ADR 0007). */
  watch(connectionId: string, instanceIds: readonly string[]): void {
    const before = new Set(this.#watchedInstances());
    for (const id of this.#watchers.get(connectionId) ?? []) this.#lastWatched.set(id, this.#deps.now());
    this.#watchers.set(connectionId, new Set(instanceIds));
    for (const id of instanceIds) {
      if (!before.has(id)) this.#pullForward(id);
    }
  }

  unwatch(connectionId: string): void {
    for (const id of this.#watchers.get(connectionId) ?? []) this.#lastWatched.set(id, this.#deps.now());
    this.#watchers.delete(connectionId);
  }

  #watchedInstances(): string[] {
    return [...this.#watchers.values()].flatMap((ids) => [...ids]);
  }

  #isWatched(instanceId: string): boolean {
    if (this.#watchedInstances().includes(instanceId)) return true;
    const last = this.#lastWatched.get(instanceId);
    return last !== undefined && this.#deps.now() - last < WATCH_GRACE_MS;
  }

  /** A viewer arrived: run now instead of waiting for the background interval. */
  #pullForward(instanceId: string): void {
    const runtime = this.#runtimes.get(instanceId);
    if (!runtime || runtime.openUntil !== null) return;
    for (const state of runtime.collectors) {
      if (state.running || !state.timer) continue;
      clearTimeout(state.timer);
      this.#schedule(runtime, state, 0);
    }
  }

  #schedule(runtime: Runtime, state: CollectorState, delayMs: number): void {
    if (this.#runtimes.get(runtime.row.id) !== runtime) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#run(runtime, state);
    }, delayMs);
    state.timer.unref();
  }

  #interval(runtime: Runtime, def: AnyCollector): number {
    return this.#isWatched(runtime.row.id) ? def.interval.activeMs : def.interval.backgroundMs;
  }

  async #run(runtime: Runtime, state: CollectorState): Promise<void> {
    const { now } = this.#deps;
    const trial = runtime.openUntil !== null;
    if (runtime.openUntil !== null) {
      if (now() < runtime.openUntil) return this.#schedule(runtime, state, runtime.openUntil - now());
      // Half-open: exactly one trial run; the other collectors wait for its outcome.
      if (runtime.trialRunning) return this.#schedule(runtime, state, this.#interval(runtime, state.def));
      runtime.trialRunning = true;
    }
    state.running = true;
    let delay: number;
    try {
      await this.#global.run(() =>
        runtime.limiter ? runtime.limiter.run(() => this.#collect(runtime, state)) : this.#collect(runtime, state),
      );
      delay = this.#succeeded(runtime, state);
    } catch (error) {
      if (runtime.controller.signal.aborted) return;
      delay = this.#failed(runtime, state, error);
    } finally {
      state.running = false;
      if (trial) runtime.trialRunning = false;
    }
    this.#schedule(runtime, state, delay);
  }

  async #collect(runtime: Runtime, state: CollectorState): Promise<void> {
    if (runtime.controller.signal.aborted) return;
    const { def } = state;
    const timeout = AbortSignal.timeout(def.timeoutMs);
    const signal = AbortSignal.any([runtime.controller.signal, timeout]);
    const log = this.#deps.log.child({ instanceId: runtime.row.id, pluginId: runtime.row.pluginId, collector: def.id });
    // A collector that ignores its signal must not hold the slot: the race ends with the timeout.
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          const error = new Error(`collector ${def.id} took longer than ${def.timeoutMs} ms`);
          error.name = 'CollectorTimeout';
          reject(error);
        },
        { once: true },
      );
    });
    const result = await Promise.race([
      def.run({
        config: runtime.config,
        secrets: runtime.secrets,
        http: runtime.http,
        log,
        now: this.#deps.now,
        signal,
      }),
      aborted,
    ]);
    if (runtime.controller.signal.aborted) return;
    const grace = 2 * def.interval.backgroundMs;
    const outcome = this.#deps.entities.applySnapshot(runtime.row.id, def.id, result, this.#deps.now(), grace);
    const version = this.#deps.now();
    if (outcome.kinds.length > 0) {
      this.#deps.bus.publish('entities', { instanceId: runtime.row.id, kinds: outcome.kinds, version });
    }
    if (outcome.seriesIds.length > 0) {
      this.#deps.bus.publish('metrics', { seriesIds: outcome.seriesIds, until: version });
    }
  }

  #succeeded(runtime: Runtime, state: CollectorState): number {
    runtime.failures = 0;
    runtime.openUntil = null;
    runtime.breakerMs = BREAKER_FIRST_MS;
    this.#setHealth(runtime, 'ok');
    return jitter(this.#interval(runtime, state.def), this.#random);
  }

  #failed(runtime: Runtime, state: CollectorState, error: unknown): number {
    const interval = this.#interval(runtime, state.def);
    runtime.failures += 1;
    this.#deps.log.warn(
      { instanceId: runtime.row.id, collector: state.def.id, failures: runtime.failures, ...describeFailure(error) },
      'collector run failed',
    );
    if (runtime.failures >= BREAKER_THRESHOLD) {
      const wait = runtime.openUntil === null ? runtime.breakerMs : Math.min(runtime.breakerMs * 2, BACKOFF_MAX_MS);
      runtime.breakerMs = wait;
      runtime.openUntil = this.#deps.now() + wait;
      this.#setHealth(runtime, 'breaker-open');
      return wait;
    }
    this.#setHealth(runtime, 'failing');
    return Math.min(jitter(interval * 2 ** runtime.failures, this.#random), BACKOFF_MAX_MS);
  }

  #setHealth(runtime: Runtime, health: InstanceHealth): void {
    if (runtime.health === health) return;
    runtime.health = health;
    this.#publishInstance(runtime);
  }

  #publishInstance(runtime: Runtime): void {
    this.#deps.bus.publish('instance', {
      instanceId: runtime.row.id,
      status: runtime.row.status,
      health: runtime.health,
    });
  }
}
