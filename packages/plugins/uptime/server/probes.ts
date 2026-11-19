import { isIP } from 'node:net';
import { type EntityInput, originOf, type PluginContext, PluginHttpError, type Target } from '@rxf/sdk';
import { DEFAULT_EXPECTED_STATUS, statusMatches } from '../shared/status.ts';
import type { DnsCheck, HttpCheck, IcmpCheck, TcpCheck, TlsCheck, UptimeCheck, UptimeConfig } from './config.ts';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TLS_PORT = 443;
const DEFAULT_WARN_DAYS = 14;
const DEFAULT_CRIT_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_RECORDS = 10;

/** One probe of one check, ready to become an entity and its metrics. */
export interface ProbeOutcome {
  status: EntityInput['status'];
  reason?: string;
  /** Short text for the connection test; never contains device answers beyond a status code. */
  message: string;
  responseMs: number | null;
  attrs: Record<string, unknown>;
  extraMetrics: { name: string; unit: string; value: number }[];
}

type Ctx = PluginContext<UptimeConfig>;

const bracket = (host: string) => (isIP(host) === 6 ? `[${host}]` : host);
const checkType = (c: UptimeCheck) => c.type ?? 'http';

/** The peer a check contacts, as listed in `targets()`; DNS checks without a server contact none. */
export function targetOf(c: UptimeCheck): Target | null {
  switch (c.type) {
    case undefined:
    case 'http':
      return { origin: originOf(c.url), tls: tlsOf(c) };
    case 'tcp':
      return { origin: originOf(`tcp://${bracket(c.host)}:${c.port}`), tls: { mode: 'system' } };
    case 'icmp':
      return { origin: originOf(`icmp://${bracket(c.host)}`), tls: { mode: 'system' } };
    case 'dns':
      return c.server ? { origin: originOf(`dns://${bracket(c.server)}:53`), tls: { mode: 'system' } } : null;
    case 'tls':
      return { origin: originOf(`tls://${bracket(c.host)}:${c.port ?? DEFAULT_TLS_PORT}`), tls: tlsOf(c) };
  }
}

function tlsOf(c: HttpCheck | TlsCheck): Target['tls'] {
  return { mode: c.tlsMode ?? 'system', ...(c.pinSha256 ? { pinSha256: c.pinSha256 } : {}) };
}

/** What the widget shows next to the name. */
function displayTarget(c: UptimeCheck): string {
  switch (c.type) {
    case undefined:
    case 'http':
      return new URL(c.url).host;
    case 'tcp':
      return `${bracket(c.host)}:${c.port}`;
    case 'icmp':
      return c.host;
    case 'dns':
      return `${c.query} (${c.recordType ?? 'A'})`;
    case 'tls':
      return `${bracket(c.host)}:${c.port ?? DEFAULT_TLS_PORT}`;
  }
}

function failed(error: PluginHttpError, attrs: Record<string, unknown> = {}): ProbeOutcome {
  return { status: 'crit', reason: error.code, message: error.message, responseMs: null, attrs, extraMetrics: [] };
}

function timed(ctx: Ctx, durationMs: number, slowCode: string, attrs: Record<string, unknown>): ProbeOutcome {
  const slow = durationMs > ctx.config.slowThresholdMs;
  return {
    status: slow ? 'warn' : 'ok',
    ...(slow ? { reason: slowCode } : {}),
    message: `${durationMs} ms`,
    responseMs: durationMs,
    attrs,
    extraMetrics: [],
  };
}

async function probeHttp(ctx: Ctx, c: HttpCheck): Promise<ProbeOutcome> {
  const method = c.method ?? 'GET';
  const expectedStatus = c.expectedStatus ?? DEFAULT_EXPECTED_STATUS;
  const attrs = { method, expectedStatus, httpStatus: null as number | null };
  try {
    const res = await ctx.http.request(method, c.url, {
      timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
    });
    attrs.httpStatus = res.status;
    if (!statusMatches(expectedStatus, res.status)) {
      const message = `HTTP ${res.status}`;
      return { status: 'crit', reason: 'HTTP_STATUS', message, responseMs: res.durationMs, attrs, extraMetrics: [] };
    }
    const outcome = timed(ctx, res.durationMs, 'HTTP_SLOW', attrs);
    return { ...outcome, message: `HTTP ${res.status}, ${res.durationMs} ms` };
  } catch (error) {
    if (!(error instanceof PluginHttpError)) throw error;
    return failed(error, attrs);
  }
}

async function probeTcp(ctx: Ctx, c: TcpCheck, origin: string): Promise<ProbeOutcome> {
  try {
    const { durationMs } = await ctx.net.tcp(origin, {
      timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
    });
    return timed(ctx, durationMs, 'TCP_SLOW', {});
  } catch (error) {
    if (!(error instanceof PluginHttpError)) throw error;
    return failed(error);
  }
}

async function probeIcmp(ctx: Ctx, c: IcmpCheck, origin: string): Promise<ProbeOutcome> {
  try {
    const result = await ctx.net.ping(origin, {
      timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
      count: c.count ?? 3,
    });
    const lossPct = Math.round(((result.sent - result.received) / result.sent) * 100);
    const avg = result.avgMs ?? 0;
    const attrs = { lossPct };
    const extraMetrics = [{ name: 'uptime.loss_pct', unit: '%', value: lossPct }];
    if (lossPct > 0) {
      const message = `${lossPct} % loss`;
      return { status: 'warn', reason: 'ICMP_LOSS', message, responseMs: avg, attrs, extraMetrics };
    }
    return { ...timed(ctx, avg, 'ICMP_SLOW', attrs), extraMetrics };
  } catch (error) {
    if (!(error instanceof PluginHttpError)) throw error;
    // The container may not ping: that says nothing about the host (docs/integrations/uptime.md).
    if (error.code === 'ICMP_UNAVAILABLE') {
      return {
        status: 'unknown',
        reason: error.code,
        message: error.message,
        responseMs: null,
        attrs: {},
        extraMetrics: [],
      };
    }
    const outcome = failed(error);
    return error.code === 'ICMP_NO_REPLY'
      ? { ...outcome, extraMetrics: [{ name: 'uptime.loss_pct', unit: '%', value: 100 }] }
      : outcome;
  }
}

async function probeDns(ctx: Ctx, c: DnsCheck, origin: string | null): Promise<ProbeOutcome> {
  const type = c.recordType ?? 'A';
  try {
    const { records, durationMs } = await ctx.net.dns(
      { name: c.query, type, ...(origin ? { server: origin } : {}) },
      { timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: ctx.signal },
    );
    const attrs = { recordType: type, records: records.slice(0, MAX_RECORDS).map((r) => r.slice(0, 255)) };
    const expected = c.expected?.trim().toLowerCase();
    if (expected && !records.some((record) => record.trim().toLowerCase() === expected)) {
      return {
        status: 'crit',
        reason: 'DNS_MISMATCH',
        message: `${c.query} does not resolve to ${c.expected}`,
        responseMs: durationMs,
        attrs,
        extraMetrics: [],
      };
    }
    return timed(ctx, durationMs, 'DNS_SLOW', attrs);
  } catch (error) {
    if (!(error instanceof PluginHttpError)) throw error;
    return failed(error, { recordType: type, records: [] });
  }
}

async function probeTls(ctx: Ctx, c: TlsCheck, origin: string): Promise<ProbeOutcome> {
  try {
    const probe = await ctx.net.tls(origin, {
      timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
      ...(c.servername ? { servername: c.servername } : {}),
    });
    const daysLeft = Math.floor((probe.validToMs - ctx.now()) / DAY_MS);
    const attrs = { daysLeft, validTo: new Date(probe.validToMs).toISOString(), issuer: probe.info.issuer };
    const extraMetrics = [{ name: 'uptime.tls_days_left', unit: 'd', value: daysLeft }];
    const base = { responseMs: probe.durationMs, attrs, extraMetrics };
    if (daysLeft < 0) return { ...base, status: 'crit', reason: 'TLS_EXPIRED', message: 'certificate has expired' };
    const message = `${daysLeft} days left`;
    if (daysLeft < (c.critDays ?? DEFAULT_CRIT_DAYS))
      return { ...base, status: 'crit', reason: 'TLS_EXPIRING', message };
    if (daysLeft < (c.warnDays ?? DEFAULT_WARN_DAYS))
      return { ...base, status: 'warn', reason: 'TLS_EXPIRING', message };
    return { ...base, status: 'ok', message };
  } catch (error) {
    if (!(error instanceof PluginHttpError)) throw error;
    return failed(error);
  }
}

/** One probe; device errors become an outcome, anything else is a bug and propagates. */
export async function probe(ctx: Ctx, c: UptimeCheck): Promise<ProbeOutcome & { endpoint: string; target: string }> {
  const origin = targetOf(c)?.origin ?? null;
  const shared = {
    endpoint: c.type === undefined || c.type === 'http' ? c.url : (origin ?? 'dns://system'),
    target: displayTarget(c),
  };
  let outcome: ProbeOutcome;
  switch (c.type) {
    case undefined:
    case 'http':
      outcome = await probeHttp(ctx, c);
      break;
    case 'tcp':
      outcome = await probeTcp(ctx, c, origin as string);
      break;
    case 'icmp':
      outcome = await probeIcmp(ctx, c, origin as string);
      break;
    case 'dns':
      outcome = await probeDns(ctx, c, origin);
      break;
    case 'tls':
      outcome = await probeTls(ctx, c, origin as string);
      break;
  }
  return { ...outcome, ...shared, attrs: { type: checkType(c), ...outcome.attrs } };
}
