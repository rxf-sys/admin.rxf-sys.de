import {
  type Capability,
  defineConfig,
  defineServerPlugin,
  field,
  originOf,
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
  checks: field(z.array(check).check(z.maxLength(200)), {
    label: { de: 'Prüfungen', en: 'Checks' },
    help: { de: 'Jede Prüfung ruft eine URL ab.', en: 'Each check fetches one URL.' },
    // URLs are targets: only admins change them, with re-authentication (ADR 0008, T8).
    adminOnly: true,
  }),
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
      try {
        const res = await ctx.http.request(c.method ?? 'GET', c.url);
        const expected = c.expectedStatus ?? DEFAULT_EXPECTED_STATUS;
        if (!statusMatches(expected, res.status)) {
          capabilities.push({ id, status: 'failed', code: 'HTTP_STATUS', message: `HTTP ${res.status}` });
        } else if (res.durationMs > ctx.config.slowThresholdMs) {
          capabilities.push({ id, status: 'ok', code: 'HTTP_SLOW', message: `${res.durationMs} ms` });
        } else {
          capabilities.push({ id, status: 'ok', message: `HTTP ${res.status}, ${res.durationMs} ms` });
        }
      } catch (error) {
        if (!(error instanceof PluginHttpError)) throw error;
        capabilities.push({ id, status: 'failed', code: error.code, message: error.message });
        if (error.code === 'TLS_SELF_SIGNED' || error.code === 'TLS_PIN_MISMATCH') {
          tls.push(await ctx.http.inspectTls(c.url));
        }
      }
    }
    const ok = !capabilities.some((cap) => cap.code !== undefined && CONFIG_ERRORS.has(cap.code));
    return tls.length > 0 ? { ok, capabilities, tls } : { ok, capabilities };
  },
});
