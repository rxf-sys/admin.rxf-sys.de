import { isIP } from 'node:net';
import { defineConfig, dnsRecordTypes, field, tlsModes } from '@rxf/sdk';
import * as z from 'zod/mini';
import { HOSTNAME_PATTERN } from '../shared/hosts.ts';
import { EXPECTED_STATUS_PATTERN } from '../shared/status.ts';

const httpUrl = z.string().check(z.refine((value) => /^https?:\/\//.test(value) && URL.canParse(value), 'http(s) URL'));

/** IPv6 zone ids (`fe80::1%eth0`) pass `isIP` but not URL parsing, so `targets()` could not list them. */
const isIpLiteral = (value: string) => isIP(value) !== 0 && !value.includes('%');
const host = z
  .string()
  .check(z.refine((value) => HOSTNAME_PATTERN.test(value) || isIpLiteral(value), 'host name or IP'));
const ipLiteral = z.string().check(z.refine(isIpLiteral, 'IP address'));
const port = z.number().check(z.int(), z.minimum(1), z.maximum(65_535));
const pinSha256 = z.string().check(z.regex(/^[0-9a-f]{64}$/));

/** Fields every check type shares. */
const common = {
  name: z.string().check(z.minLength(1), z.maxLength(80)),
  /** Own interval in seconds; without it the check runs every 30 s while watched and 60 s otherwise. */
  intervalS: z.optional(z.number().check(z.int(), z.minimum(10), z.maximum(3600))),
  timeoutMs: z.optional(z.number().check(z.int(), z.minimum(500), z.maximum(30_000))),
};

/** `type` is optional for HTTP: configs from before Phase 5 have none. */
const httpCheck = z.object({
  type: z.optional(z.literal('http')),
  ...common,
  url: httpUrl,
  method: z.optional(z.enum(['GET', 'HEAD'])),
  expectedStatus: z.optional(z.string().check(z.regex(EXPECTED_STATUS_PATTERN))),
  tlsMode: z.optional(z.enum(tlsModes)),
  pinSha256: z.optional(pinSha256),
});

const tcpCheck = z.object({ type: z.literal('tcp'), ...common, host, port });

const icmpCheck = z.object({
  type: z.literal('icmp'),
  ...common,
  host,
  count: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(10))),
});

const dnsCheck = z.object({
  type: z.literal('dns'),
  ...common,
  /** The name to resolve. */
  query: host,
  recordType: z.optional(z.enum(dnsRecordTypes)),
  /** Resolver to ask; the system resolver without it. Node's resolver takes IP addresses only. */
  server: z.optional(ipLiteral),
  /** One of the answers must equal this (case-insensitive). */
  expected: z.optional(z.string().check(z.minLength(1), z.maxLength(255))),
});

const tlsCheck = z.object({
  type: z.literal('tls'),
  ...common,
  host,
  port: z.optional(port),
  servername: z.optional(host),
  warnDays: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(365))),
  critDays: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(365))),
  tlsMode: z.optional(z.enum(tlsModes)),
  pinSha256: z.optional(pinSha256),
});

const check = z.union([httpCheck, tcpCheck, icmpCheck, dnsCheck, tlsCheck]);

export type UptimeCheck = z.infer<typeof check>;
export type HttpCheck = z.infer<typeof httpCheck>;
export type TcpCheck = z.infer<typeof tcpCheck>;
export type IcmpCheck = z.infer<typeof icmpCheck>;
export type DnsCheck = z.infer<typeof dnsCheck>;
export type TlsCheck = z.infer<typeof tlsCheck>;

export const config = defineConfig({
  checks: field(
    z.array(check).check(
      z.maxLength(200),
      z.refine((checks) => new Set(checks.map((c) => c.name)).size === checks.length, 'check names must be unique'),
    ),
    {
      label: { de: 'Prüfungen', en: 'Checks' },
      help: {
        de: 'HTTP, TCP, Ping, DNS oder Zertifikatsablauf.',
        en: 'HTTP, TCP, ping, DNS or certificate expiry.',
      },
      // Hosts and URLs are targets: only admins change them, with re-authentication (ADR 0008, T8).
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

export type UptimeConfig = z.infer<typeof config.schema>;
