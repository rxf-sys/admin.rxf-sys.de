import {
  type Capability,
  type Collector,
  type CollectResult,
  defineServerPlugin,
  type PluginContext,
  PluginHttpError,
  type Target,
  type TlsInfo,
} from '@rxf/sdk';
import { config, type UptimeCheck, type UptimeConfig } from './config.ts';
import { probe, targetOf } from './probes.ts';

export type { UptimeCheck } from './config.ts';

/** Failures that mean the configuration is wrong, as opposed to a service that is down right now. */
const CONFIG_ERRORS = new Set([
  'TARGET_BLOCKED',
  'TARGET_NOT_ALLOWED',
  'REQUEST_NOT_ALLOWED',
  'TLS_SELF_SIGNED',
  'TLS_PIN_MISMATCH',
  'TLS_HOSTNAME',
  'TLS_INVALID',
]);

/** Codes for which the connection test shows the certificate so the admin can pin it (TOFU). */
const TOFU_CODES = new Set(['TLS_SELF_SIGNED', 'TLS_PIN_MISMATCH', 'TLS_HOSTNAME']);

/** Checks probed at the same time within one run. */
const PARALLEL_CHECKS = 8;
/** docs/integrations/uptime.md: 30 s while watched, 60 s otherwise, so outages alert within 2 min. */
const DEFAULT_INTERVAL = { activeMs: 30_000, backgroundMs: 60_000 };
const RUN_TIMEOUT_MS = 55_000;
export const DEFAULT_COLLECTOR = 'checks';

async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Every check becomes a `Service` entity with a status series and, when measured, a response time. */
async function collect(ctx: PluginContext<UptimeConfig>, checks: readonly UptimeCheck[]): Promise<CollectResult> {
  const outcomes = await mapLimit(checks, PARALLEL_CHECKS, (c) => probe(ctx, c));
  const out: CollectResult = { entities: [], metrics: [] };
  const ts = ctx.now();
  for (const [i, c] of checks.entries()) {
    const outcome = outcomes[i] as Awaited<ReturnType<typeof probe>>;
    const entity = { kind: 'Service' as const, externalId: c.name };
    out.entities.push({
      ...entity,
      name: c.name,
      status: outcome.status,
      ...(outcome.reason ? { statusReason: outcome.reason } : {}),
      attrs: { endpoint: outcome.endpoint, target: outcome.target, responseMs: outcome.responseMs, ...outcome.attrs },
    });
    // `unknown` (ping not possible here) says nothing about the service, so it writes no status value.
    if (outcome.status !== 'unknown') {
      out.metrics.push({ entity, name: 'uptime.status', unit: '', value: outcome.status === 'crit' ? 0 : 1, ts });
    }
    if (outcome.responseMs !== null) {
      out.metrics.push({ entity, name: 'uptime.response_ms', unit: 'ms', value: outcome.responseMs, ts });
    }
    for (const metric of outcome.extraMetrics) out.metrics.push({ entity, ...metric, ts });
  }
  return out;
}

/**
 * One collector per interval: checks without their own interval share `checks`, the others are grouped
 * as `checks-<s>s`. A check that leaves the config is missing from the next snapshot and deleted at once
 * (owner decision 19.11.2026).
 */
function collectorsFor(cfg: UptimeConfig): Collector<UptimeConfig>[] {
  const intervals = [...new Set(cfg.checks.map((c) => c.intervalS ?? null))].sort((a, b) => (a ?? 0) - (b ?? 0));
  return intervals.map((intervalS) => ({
    id: intervalS === null ? DEFAULT_COLLECTOR : `${DEFAULT_COLLECTOR}-${intervalS}s`,
    interval: intervalS === null ? DEFAULT_INTERVAL : { activeMs: intervalS * 1000, backgroundMs: intervalS * 1000 },
    timeoutMs: RUN_TIMEOUT_MS,
    onMissing: 'delete' as const,
    // The run reads its checks from the config it is handed, matched by interval.
    run: (ctx) =>
      collect(
        ctx,
        ctx.config.checks.filter((c) => (c.intervalS ?? null) === intervalS),
      ),
  }));
}

export default defineServerPlugin({
  config,

  targets(cfg) {
    const byOrigin = new Map<string, Target>();
    for (const c of cfg.checks) {
      const target = targetOf(c);
      if (target && !byOrigin.has(target.origin)) byOrigin.set(target.origin, target);
    }
    return [...byOrigin.values()];
  },

  allowBlockedAddresses: (cfg) => cfg.allowBlockedTargets,

  requests: {
    collect: [
      { method: 'GET', path: '/**' },
      { method: 'HEAD', path: '/**' },
    ],
  },

  /**
   * Runs every check once. `ok` is false only for configuration errors (blocked target, TLS); a service
   * that is down is a valid result for an uptime check and does not block activation.
   */
  async test(ctx) {
    const capabilities: Capability[] = [];
    const tls: TlsInfo[] = [];
    for (const c of ctx.config.checks) {
      const id = `check:${c.name}`;
      const outcome = await probe(ctx, c);
      const code = outcome.reason ? { code: outcome.reason } : {};
      if (outcome.status === 'crit') {
        capabilities.push({ id, status: 'failed', ...code, message: outcome.message });
        const origin = targetOf(c)?.origin;
        if (outcome.reason && TOFU_CODES.has(outcome.reason) && origin) {
          try {
            tls.push(await ctx.http.inspectTls(origin));
          } catch (error) {
            if (!(error instanceof PluginHttpError)) throw error;
          }
        }
      } else if (outcome.status === 'unknown') {
        capabilities.push({ id, status: 'unsupported', ...code, message: outcome.message });
      } else {
        capabilities.push({ id, status: 'ok', ...code, message: outcome.message });
      }
    }
    const ok = !capabilities.some((cap) => cap.code !== undefined && CONFIG_ERRORS.has(cap.code));
    return tls.length > 0 ? { ok, capabilities, tls } : { ok, capabilities };
  },

  collectors: collectorsFor,
});
