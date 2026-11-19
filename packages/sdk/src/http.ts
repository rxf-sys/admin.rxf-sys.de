import { createHash, X509Certificate } from 'node:crypto';
import { isIP, type LookupFunction } from 'node:net';
import { type PeerCertificate, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { Agent, buildConnector, request } from 'undici';
import { PluginHttpError } from './errors.ts';
import { bareHost, createAddressGuard } from './guard.ts';
import { originOf, type Target, type TlsSettings } from './targets.ts';

/** Method plus path pattern; `*` matches one path segment, `**` the rest of the path. */
export interface RequestRule {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}

export interface TlsInfo {
  origin: string;
  /** SHA-256 of the DER leaf certificate (for `pin-leaf`). */
  leafSha256: string;
  /** SHA-256 of the DER SubjectPublicKeyInfo (for `pin-spki`). */
  spkiSha256: string;
  subject: string;
  issuer: string;
  subjectAltName: string | null;
  validTo: string;
  /** Whether the system trust store accepted the chain and host name. */
  trusted: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

export interface HttpClient {
  request(
    method: RequestRule['method'],
    url: string,
    init?: {
      headers?: Record<string, string>;
      /** Shorter than the client timeout for this request; longer values are capped. */
      timeoutMs?: number;
      /** Aborts the request, e.g. when the instance is paused. */
      signal?: AbortSignal;
    },
  ): Promise<HttpResponse>;
  /**
   * Reads the certificate of an https or tls target without trusting it, for the TOFU dialog (ADR 0008).
   * `servername` sets SNI when the check uses one, so the dialog shows the certificate the probe sees.
   */
  inspectTls(origin: string, init?: { servername?: string }): Promise<TlsInfo>;
  close(): Promise<void>;
}

export interface HttpClientOptions {
  targets: readonly Target[];
  requests: readonly RequestRule[];
  timeoutMs: number;
  /** Lets an admin reach blocked ranges on purpose (e.g. a check against the host itself). */
  allowBlockedAddresses?: boolean;
  /** Body bytes kept for keyword checks; the rest is discarded. */
  maxBodyBytes?: number;
  /** For tests. */
  lookup?: LookupFunction;
}

function matchesPattern(pattern: string, path: string): boolean {
  const want = pattern.split('/');
  const have = path.split('/');
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '**') return true;
    if (i >= have.length) return false;
    if (want[i] !== '*' && want[i] !== have[i]) return false;
  }
  return want.length === have.length;
}

const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export function tlsInfo(origin: string, socket: TLSSocket): TlsInfo {
  const cert = socket.getPeerCertificate() as PeerCertificate;
  const x509 = new X509Certificate(cert.raw);
  return {
    origin,
    leafSha256: sha256Hex(cert.raw),
    spkiSha256: sha256Hex(x509.publicKey.export({ type: 'spki', format: 'der' })),
    subject: x509.subject,
    issuer: x509.issuer,
    subjectAltName: x509.subjectAltName ?? null,
    validTo: x509.validTo,
    trusted: socket.authorized,
  };
}

export function checkPin(settings: TlsSettings, info: TlsInfo): void {
  const actual = settings.mode === 'pin-leaf' ? info.leafSha256 : info.spkiSha256;
  if (!settings.pinSha256 || actual !== settings.pinSha256) {
    throw new PluginHttpError('TLS_PIN_MISMATCH', `certificate of ${info.origin} does not match the stored pin`);
  }
}

function requestSignal(init: { timeoutMs?: number; signal?: AbortSignal }, clientTimeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.min(init.timeoutMs ?? clientTimeoutMs, clientTimeoutMs));
  return init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
}

function mapNetworkError(error: unknown, origin: string): PluginHttpError {
  if (error instanceof PluginHttpError) return error;
  const code = (error as { code?: string }).code ?? '';
  const cause = (error as { cause?: { code?: string } }).cause?.code ?? '';
  const any = `${code} ${cause}`;
  if (/SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF/.test(any)) {
    return new PluginHttpError('TLS_SELF_SIGNED', `${origin} presents a certificate the system does not trust`);
  }
  if (/CERT|ERR_TLS|ALTNAME/.test(any)) return new PluginHttpError('TLS_INVALID', `TLS with ${origin} failed`);
  if (/ENOTFOUND|EAI_AGAIN/.test(any)) return new PluginHttpError('DNS_NOT_FOUND', `${origin} does not resolve`);
  if (/ECONNREFUSED/.test(any)) return new PluginHttpError('CONNECTION_REFUSED', `${origin} refused the connection`);
  // An aborted run (collector timeout, instance paused) reads like a timeout to the plugin.
  const name = (error as Error).name;
  if (/TIMEOUT|ABORT/i.test(any) || name === 'TimeoutError' || name === 'AbortError') {
    return new PluginHttpError('HTTP_TIMEOUT', `${origin} did not answer in time`);
  }
  return new PluginHttpError('NETWORK_ERROR', `request to ${origin} failed`);
}

/**
 * HTTP client for one plugin instance (ADR 0008, T8–T10). It refuses origins outside the instance's
 * targets and requests outside its rules before connecting, checks the resolved address of every
 * connection against the block list (also defeating DNS rebinding), never follows redirects and
 * applies the target's TLS mode.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const guard = createAddressGuard({ allowBlocked: options.allowBlockedAddresses ?? false, lookup: options.lookup });
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const targets = new Map(options.targets.map((target) => [originOf(target.origin), target]));
  const agents = new Map<string, Agent>();

  function agentFor(target: Target): Agent {
    const origin = originOf(target.origin);
    let agent = agents.get(origin);
    if (agent) return agent;
    const { tls } = target;
    const verify = tls.mode === 'system' || tls.mode === 'ca';
    const connector = buildConnector({
      lookup: guard.lookup,
      timeout: options.timeoutMs,
      rejectUnauthorized: verify,
      ...(tls.mode === 'ca' && tls.caPem ? { ca: tls.caPem } : {}),
    });
    agent = new Agent({
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      connect: (connectOptions, callback) => {
        connector(connectOptions, (error, socket) => {
          if (error || !socket) return callback(error ?? new Error('no socket'), null);
          if (tls.mode === 'pin-leaf' || tls.mode === 'pin-spki') {
            try {
              checkPin(tls, tlsInfo(origin, socket as TLSSocket));
            } catch (pinError) {
              socket.destroy();
              return callback(pinError as Error, null);
            }
          }
          return callback(null, socket);
        });
      },
    });
    agents.set(origin, agent);
    return agent;
  }

  return {
    async request(method, url, init = {}) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new PluginHttpError('TARGET_NOT_ALLOWED', `scheme ${parsed.protocol} is not allowed`);
      }
      const origin = originOf(parsed);
      const target = targets.get(origin);
      if (!target) throw new PluginHttpError('TARGET_NOT_ALLOWED', `${origin} is not a target of this instance`);
      // Encoded slashes would let one "segment" span several on servers that decode them.
      const encodedSeparator = /%2f|%5c/i.test(parsed.pathname);
      if (
        encodedSeparator ||
        !options.requests.some((rule) => rule.method === method && matchesPattern(rule.path, parsed.pathname))
      ) {
        throw new PluginHttpError('REQUEST_NOT_ALLOWED', `${method} ${parsed.pathname} is not an allowed request`);
      }
      guard.assertAllowed(bareHost(parsed.hostname));
      const started = performance.now();
      try {
        const response = await request(parsed, {
          method,
          headers: init.headers,
          // undici's request() never follows redirects without a redirect interceptor; a test pins this.
          dispatcher: agentFor(target),
          signal: requestSignal(init, options.timeoutMs),
        });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          const buffer = chunk as Buffer;
          if (size < maxBody) chunks.push(buffer.subarray(0, maxBody - size));
          size += buffer.length;
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          headers[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
        }
        return {
          status: response.statusCode,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        throw mapNetworkError(error, origin);
      }
    },

    async inspectTls(originInput, init = {}) {
      const origin = originOf(originInput);
      const target = targets.get(origin);
      if (!target || !(origin.startsWith('https:') || origin.startsWith('tls:'))) {
        throw new PluginHttpError('TARGET_NOT_ALLOWED', `${origin} is not a TLS target of this instance`);
      }
      const host = bareHost(new URL(origin).hostname);
      guard.assertAllowed(host);
      // `URL.port` is empty for default ports; the normalised origin always carries the port.
      const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
      return new Promise<TlsInfo>((resolve, reject) => {
        const socket = tlsConnect({
          host,
          port,
          servername: init.servername ?? (isIP(host) ? undefined : host),
          lookup: guard.lookup,
          rejectUnauthorized: false,
          timeout: options.timeoutMs,
        });
        socket.once('secureConnect', () => {
          const info = tlsInfo(origin, socket);
          socket.end();
          resolve(info);
        });
        socket.once('timeout', () => {
          socket.destroy();
          reject(new PluginHttpError('HTTP_TIMEOUT', `${origin} did not answer in time`));
        });
        socket.once('error', (error) => reject(mapNetworkError(error, origin)));
      });
    },

    async close() {
      await Promise.all([...agents.values()].map((agent) => agent.close()));
      agents.clear();
    },
  };
}
