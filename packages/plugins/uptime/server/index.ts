import {
  type Capability,
  type CollectResult,
  defineConfig,
  defineServerPlugin,
  field,
  originOf,
  type PluginContext,
  PluginHttpError,
  type Target,
  type TlsInfo,
  tlsModes,
} from '@rxf/sdk';
import * as z from 'zod/mini';
import { DEFAULT_EXPECTED_STATUS, EXPECTED_STATUS_PATTERN, statusMatches } from './status.ts';

const httpUrl = z.string().check(z.refine((value) => /^https?:\/\//.test(value) && URL.canParse(value), 'http(s) URL'));

const check = z.object({
  name: z.string().check(z.minLength(1), z.maxLength(80)),
  url: httpUrl,
  method: z.optional(z.enum(['GET', 'HEAD'])),
  expectedStatus: z.optional(z.string().check(z.regex(EXPECTED_STATUS_PATTERN))),
  timeoutMs: z.optional(z.number().check(z.int(), z.minimum(500), z.maximum(30_000))),
  tlsMode: z.optional(z.enum(tlsModes)),
  pinSha256: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
});

export type UptimeCheck = z.infer<typeof check>;

const config = defineConfig({
  checks: field(
    z.array(check).check(
      z.maxLength(200),
      z.refine((checks) => new Set(checks.map((c) => c.name)).size === checks.length, 'check names must be unique'),
    ),
    {
      label: { de: 'Prüfungen', en: 'Checks' },
      help: { de: 'Jede Prüfung ruft eine URL ab.', en: 'Each check fetches one URL.' },
      // URLs are targets: only admins change them, with re-authentication (ADR 0008, T8).
      adminOnly: true,
    },
  ),
  slowThresholdMs: field(z.number().check(z.int(), z.minimum(50), z.maximum(60_000)), {
    label: { de: 'Langsam ab (ms)', en: 'Slow from (ms)' },
  }),
  allowBlockedTargets: field(z.boolean(), {
    label: { de: 'Gesperrte Adressen erlauben', en: 'Allow blocked addresses' },
    help: {
      de: 'Nur für Prüfungen gegen den eigenen Host (Loopback).',
      en: 'Only for checks against this host (loopback).',
    },
    adminOnly: true,
  }),
});

/** Failures that mean the configuration is wrong, as opposed to a service that is down right now. */
const CONFIG_ERRORS = new Set([
  'TARGET_BLOCKED',
  'TARGET_NOT_ALLOWED',
  'REQUEST_NOT_ALLOWED',
  'TLS_SELF_SIGNED',
  'TLS_PIN_MISMATCH',
  'TLS_INVALID',
]);

type UptimeConfig = z.infer<typeof config.schema>;

const DEFAULT_TIMEOUT_MS = 10_000;
/** Checks probed at the same time within one run. */
const PARALLEL_CHECKS = 8;

type ProbeResult =
  | { outcome: 'ok' | 'slow'; httpStatus: number; durationMs: number }
  | { outcome: 'failed'; code: string; message: string; httpStatus: number | null; durationMs: number | null };

/** One request for one check; device errors become a result, anything else is a bug and propagates. */
async function probe(ctx: PluginContext<UptimeConfig>, c: UptimeCheck): Promise<ProbeResult> {
  try {
    const res = await ctx.http.request(c.method ?? 'GET', c.url, {
      timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (!statusMatches(c.expectedStatus ?? DEFAULT_EXPECTED_STATUS, res.status)) {
      const message = `HTTP ${res.status}`;
      return { outcome: 'failed', code: 'HTTP_STATUS', message, httpStatus: res.status, durationMs: res.durationMs };
    }
    const outcome = res.durationMs > ctx.config.slowThresholdMs ? 'slow' : 'ok';
    return { outcome, httpStatus: res.status, durationMs: res.durationMs };
  } catch (error) {
    if (!(error instanceof PluginHttpError)) throw error;
    return { outcome: 'failed', code: error.code, message: error.message, httpStatus: null, durationMs: null };
  }
}

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

/** Every check becomes a `Service` entity with `attrs.endpoint` and two series (docs/integrations/uptime.md). */
async function collectChecks(ctx: PluginContext<UptimeConfig>): Promise<CollectResult> {
  const results = await mapLimit(ctx.config.checks, PARALLEL_CHECKS, (c) => probe(ctx, c));
  const out: CollectResult = { entities: [], metrics: [] };
  const ts = ctx.now();
  for (const [i, c] of ctx.config.checks.entries()) {
    const result = results[i] as ProbeResult;
    const entity = { kind: 'Service' as const, externalId: c.name };
    const failed = result.outcome === 'failed';
    out.entities.push({
      ...entity,
      name: c.name,
      status: failed ? 'crit' : result.outcome === 'slow' ? 'warn' : 'ok',
      ...(failed ? { statusReason: result.code } : result.outcome === 'slow' ? { statusReason: 'HTTP_SLOW' } : {}),
      attrs: {
        endpoint: c.url,
        method: c.method ?? 'GET',
        expectedStatus: c.expectedStatus ?? DEFAULT_EXPECTED_STATUS,
        httpStatus: result.httpStatus,
        responseMs: result.durationMs,
      },
    });
    out.metrics.push({ entity, name: 'uptime.status', unit: '', value: failed ? 0 : 1, ts });
    if (result.durationMs !== null) {
      out.metrics.push({ entity, name: 'uptime.response_ms', unit: 'ms', value: result.durationMs, ts });
    }
  }
  return out;
}

export default defineServerPlugin({
  config,

  targets(cfg) {
    const byOrigin = new Map<string, Target>();
    for (const c of cfg.checks) {
      const origin = originOf(c.url);
      if (!byOrigin.has(origin)) {
        const pin = c.pinSha256 ? { pinSha256: c.pinSha256 } : {};
        byOrigin.set(origin, { origin, tls: { mode: c.tlsMode ?? 'system', ...pin } });
      }
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
      const result = await probe(ctx, c);
      if (result.outcome === 'failed') {
        capabilities.push({ id, status: 'failed', code: result.code, message: result.message });
        if (result.code === 'TLS_SELF_SIGNED' || result.code === 'TLS_PIN_MISMATCH') {
          tls.push(await ctx.http.inspectTls(c.url));
        }
      } else if (result.outcome === 'slow') {
        capabilities.push({ id, status: 'ok', code: 'HTTP_SLOW', message: `${result.durationMs} ms` });
      } else {
        capabilities.push({ id, status: 'ok', message: `HTTP ${result.httpStatus}, ${result.durationMs} ms` });
      }
    }
    const ok = !capabilities.some((cap) => cap.code !== undefined && CONFIG_ERRORS.has(cap.code));
    return tls.length > 0 ? { ok, capabilities, tls } : { ok, capabilities };
  },

  collectors: [
    {
      id: 'http',
      // docs/integrations/uptime.md: 30 s while watched, 60 s otherwise, so outages alert within 2 min.
      interval: { activeMs: 30_000, backgroundMs: 60_000 },
      timeoutMs: 55_000,
      run: collectChecks,
    },
  ],
});
