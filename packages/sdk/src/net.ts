import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { isIP, type LookupFunction, connect as netConnect } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { PluginHttpError } from './errors.ts';
import { type AddressGuard, bareHost, createAddressGuard } from './guard.ts';
import { checkPin, type TlsInfo, tlsInfo } from './http.ts';
import { originOf, type Target } from './targets.ts';

export const dnsRecordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'] as const;
export type DnsRecordType = (typeof dnsRecordTypes)[number];

export interface ProbeInit {
  /** Shorter than the client timeout for this probe; longer values are capped. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TlsProbe {
  durationMs: number;
  info: TlsInfo;
  /** Unix ms of the leaf certificate's `notAfter`. */
  validToMs: number;
}

export interface PingResult {
  sent: number;
  received: number;
  /** Average round trip of the replies; null without replies. */
  avgMs: number | null;
}

/**
 * Connection-level probes for checks that are not HTTP (uptime). Every probe is limited to the
 * instance's targets and the address guard, like the HTTP client (ADR 0008, T8).
 */
export interface NetClient {
  /** Opens and closes a TCP connection to `tcp://host:port`. */
  tcp(origin: string, init?: ProbeInit): Promise<{ durationMs: number }>;
  /**
   * TLS handshake with `tls://host:port`, judged by the target's TLS mode. Throws `TLS_EXPIRED`,
   * `TLS_SELF_SIGNED`, `TLS_HOSTNAME`, `TLS_PIN_MISMATCH` …; a pinned certificate past its end date
   * still returns, so the caller can report the expiry itself.
   */
  tls(origin: string, init?: ProbeInit & { servername?: string }): Promise<TlsProbe>;
  /** Resolves a name, through `dns://ip:port` when given, otherwise through the system resolver. */
  dns(
    query: { name: string; type: DnsRecordType; server?: string },
    init?: ProbeInit,
  ): Promise<{ records: string[]; durationMs: number }>;
  /** ICMP echo to `icmp://host`; `ICMP_UNAVAILABLE` when the container may not ping. */
  ping(origin: string, init?: ProbeInit & { count?: number }): Promise<PingResult>;
}

/** Runs `ping` without a shell; replaceable in tests (CI never pings for real). */
export type PingRunner = (
  args: readonly string[],
  options: { timeoutMs: number; signal: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface NetClientOptions {
  targets: readonly Target[];
  timeoutMs: number;
  allowBlockedAddresses?: boolean;
  /** For tests. */
  lookup?: LookupFunction;
  ping?: PingRunner;
}

const systemPing: PingRunner = (args, { timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    execFile(
      'ping',
      args,
      // LC_ALL=C: the summary lines are translated otherwise.
      { timeout: timeoutMs, signal, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });

function probeSignal(init: ProbeInit, clientTimeoutMs: number): { signal: AbortSignal; timeoutMs: number } {
  const timeoutMs = Math.min(init.timeoutMs ?? clientTimeoutMs, clientTimeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout, timeoutMs };
}

function mapSocketError(error: unknown, origin: string): PluginHttpError {
  if (error instanceof PluginHttpError) return error;
  const code = (error as { code?: string }).code ?? '';
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code)) {
    return new PluginHttpError('DNS_NOT_FOUND', `${origin} does not resolve`);
  }
  if (code === 'ECONNREFUSED') return new PluginHttpError('CONNECTION_REFUSED', `${origin} refused the connection`);
  if (/EHOSTUNREACH|ENETUNREACH/.test(code)) return new PluginHttpError('NET_UNREACHABLE', `no route to ${origin}`);
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR' || (error as Error).name === 'AbortError') {
    return new PluginHttpError('CONNECT_TIMEOUT', `${origin} did not answer in time`);
  }
  return new PluginHttpError('NETWORK_ERROR', `connection to ${origin} failed`);
}

/** Node's `authorizationError` codes (OpenSSL names) mapped to the SDK's error codes. */
function tlsAuthorizationError(reason: string, origin: string): PluginHttpError {
  if (reason === 'CERT_HAS_EXPIRED') return new PluginHttpError('TLS_EXPIRED', `certificate of ${origin} has expired`);
  if (reason === 'CERT_NOT_YET_VALID') {
    return new PluginHttpError('TLS_NOT_YET_VALID', `certificate of ${origin} is not valid yet`);
  }
  if (/SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF/.test(reason)) {
    return new PluginHttpError('TLS_SELF_SIGNED', `${origin} presents a certificate the system does not trust`);
  }
  if (/ALTNAME|HOST/.test(reason)) {
    return new PluginHttpError('TLS_HOSTNAME', `certificate of ${origin} is not valid for this host name`);
  }
  return new PluginHttpError('TLS_INVALID', `TLS with ${origin} failed`);
}

const DNS_SERVER_PATTERN = /^dns:\/\/(\[[0-9a-f:.]+\]|[0-9.]+):\d+$/;

function dnsError(error: unknown, name: string): PluginHttpError {
  if (error instanceof PluginHttpError) return error;
  const code = (error as { code?: string }).code ?? '';
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL' || code === 'EREFUSED') {
    return new PluginHttpError('DNS_NOT_FOUND', `${name} has no such record`);
  }
  if (code === 'ETIMEOUT' || code === 'ECONNREFUSED' || code === 'ECANCELLED') {
    return new PluginHttpError('DNS_TIMEOUT', `the DNS server did not answer for ${name}`);
  }
  return new PluginHttpError('NETWORK_ERROR', `DNS query for ${name} failed`);
}

async function query(resolver: Resolver, name: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case 'A':
      return resolver.resolve4(name);
    case 'AAAA':
      return resolver.resolve6(name);
    case 'CNAME':
      return (await resolver.resolveCname(name)).map((value) => value.toLowerCase());
    case 'NS':
      return (await resolver.resolveNs(name)).map((value) => value.toLowerCase());
    case 'MX':
      return (await resolver.resolveMx(name)).map((record) => record.exchange.toLowerCase());
    case 'TXT':
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  }
}

/** `3 packets transmitted, 2 received` and `rtt min/avg/max/mdev = 0.1/0.2/0.3/0.0 ms` (iputils, LC_ALL=C). */
export function parsePing(stdout: string): PingResult | null {
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(stdout);
  if (!counts) return null;
  const rtt = /= [\d.]+\/([\d.]+)\//.exec(stdout);
  const received = Number(counts[2]);
  return {
    sent: Number(counts[1]),
    received,
    avgMs: received > 0 && rtt ? Math.round(Number(rtt[1]) * 10) / 10 : null,
  };
}

/** Net client for one plugin instance; shares the address rules of the HTTP client (ADR 0008, T8). */
export function createNetClient(options: NetClientOptions): NetClient {
  const guard: AddressGuard = createAddressGuard({
    allowBlocked: options.allowBlockedAddresses ?? false,
    lookup: options.lookup,
  });
  const targets = new Map(options.targets.map((target) => [originOf(target.origin), target]));
  const runPing = options.ping ?? systemPing;

  function target(input: string, scheme: string): { origin: string; target: Target; host: string; port: number } {
    const origin = originOf(input);
    const found = targets.get(origin);
    if (!found || !origin.startsWith(`${scheme}:`)) {
      throw new PluginHttpError('TARGET_NOT_ALLOWED', `${origin} is not a ${scheme} target of this instance`);
    }
    const host = bareHost(new URL(origin).hostname);
    guard.assertAllowed(host);
    const portIndex = origin.lastIndexOf(':');
    return { origin, target: found, host, port: scheme === 'icmp' ? 0 : Number(origin.slice(portIndex + 1)) };
  }

  return {
    async tcp(input, init = {}) {
      const { origin, host, port } = target(input, 'tcp');
      const { signal } = probeSignal(init, options.timeoutMs);
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const socket = netConnect({ host, port, lookup: guard.lookup, signal });
        socket.once('connect', () => {
          const durationMs = Math.round(performance.now() - started);
          socket.destroy();
          resolve({ durationMs });
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(mapSocketError(error, origin));
        });
      });
    },

    async tls(input, init = {}) {
      const { origin, target: found, host, port } = target(input, 'tls');
      const { signal } = probeSignal(init, options.timeoutMs);
      const settings = found.tls;
      const servername = init.servername ?? (isIP(host) ? undefined : host);
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const socket = tlsConnect({
          host,
          port,
          ...(servername ? { servername } : {}),
          lookup: guard.lookup,
          // Judged below: the pin modes replace the chain check, and an expired chain is reported, not hidden.
          rejectUnauthorized: false,
          ...(settings.mode === 'ca' && settings.caPem ? { ca: settings.caPem } : {}),
        });
        const abort = () => socket.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        socket.once('close', () => signal.removeEventListener('abort', abort));
        socket.once('secureConnect', () => {
          const durationMs = Math.round(performance.now() - started);
          try {
            const info = tlsInfo(origin, socket as TLSSocket);
            const validToMs = Date.parse(info.validTo);
            if (settings.mode === 'pin-leaf' || settings.mode === 'pin-spki') {
              checkPin(settings, info);
            } else if (!socket.authorized) {
              throw tlsAuthorizationError(String(socket.authorizationError ?? ''), origin);
            }
            resolve({ durationMs, info, validToMs });
          } catch (error) {
            reject(error);
          } finally {
            socket.destroy();
          }
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(mapSocketError(error, origin));
        });
      });
    },

    async dns(dnsQuery, init = {}) {
      const resolver = new Resolver({
        timeout: Math.min(init.timeoutMs ?? options.timeoutMs, options.timeoutMs),
        tries: 1,
      });
      if (dnsQuery.server !== undefined) {
        const origin = originOf(dnsQuery.server);
        if (!targets.has(origin) || !DNS_SERVER_PATTERN.test(origin)) {
          throw new PluginHttpError('TARGET_NOT_ALLOWED', `${origin} is not a DNS server of this instance`);
        }
        const url = new URL(origin);
        const host = bareHost(url.hostname);
        guard.assertAllowed(host);
        resolver.setServers([isIP(host) === 6 ? `[${host}]:${url.port || 53}` : `${host}:${url.port || 53}`]);
      }
      const { signal } = probeSignal(init, options.timeoutMs);
      const cancel = () => resolver.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      const started = performance.now();
      try {
        const records = await query(resolver, dnsQuery.name, dnsQuery.type);
        return { records, durationMs: Math.round(performance.now() - started) };
      } catch (error) {
        throw dnsError(error, dnsQuery.name);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },

    async ping(input, init = {}) {
      const { origin, host } = target(input, 'icmp');
      const { signal, timeoutMs } = probeSignal(init, options.timeoutMs);
      const count = Math.min(Math.max(init.count ?? 3, 1), 10);
      // Ping the resolved, checked address: the name could resolve elsewhere for `ping` (rebinding).
      let address: string;
      try {
        address = await guard.resolve(host);
      } catch (error) {
        throw mapSocketError(error, origin);
      }
      const deadlineS = Math.max(1, Math.floor(timeoutMs / 1000));
      // -n: no reverse lookups; -w: overall deadline; `--` ends options before the address.
      const args = ['-n', '-c', String(count), '-i', '0.2', '-w', String(deadlineS), '--', address];
      let run: Awaited<ReturnType<PingRunner>>;
      try {
        run = await runPing(args, { timeoutMs: timeoutMs + 1000, signal });
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          throw new PluginHttpError('ICMP_UNAVAILABLE', 'ping is not installed');
        }
        if ((error as { killed?: boolean }).killed) {
          throw new PluginHttpError('CONNECT_TIMEOUT', `ping to ${origin} did not finish in time`);
        }
        throw mapSocketError(error, origin);
      }
      if (/not permitted|permission denied|lacking privilege/i.test(run.stderr)) {
        throw new PluginHttpError('ICMP_UNAVAILABLE', 'this container may not send ICMP echo requests');
      }
      const result = parsePing(run.stdout);
      if (!result) throw new PluginHttpError('NETWORK_ERROR', `ping to ${origin} failed`);
      if (result.received === 0) throw new PluginHttpError('ICMP_NO_REPLY', `${origin} did not answer the ping`);
      return result;
    },
  };
}
