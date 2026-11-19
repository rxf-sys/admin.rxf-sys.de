import { isIPv6 } from 'node:net';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  host: string;
  port: number;
  version: string;
  production: boolean;
  /** Directory for the database and pre-migration backups (Docker volume in production). */
  dataDir: string;
  masterKeyFile: string;
  /** Inline master key, development only (ADR 0006). */
  masterKeyInline: string | undefined;
  /** Addresses or CIDRs of the reverse proxy (Caddy) whose X-Forwarded-For is trusted. */
  trustedProxies: string[];
  /** Origin the browser sees (`https://admin.rxf-sys.de`); passkeys are bound to its hostname (ADR 0005). */
  publicOrigin: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function parseTrustedProxies(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((entry) => {
    const value = entry.trim();
    const [address = '', prefix] = value.split('/');
    const isV4 = IPV4.test(address);
    const isV6 = !isV4 && isIPv6(address);
    const maxPrefix = isV4 ? 32 : 128;
    const prefixOk = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (!(isV4 || isV6) || !prefixOk) {
      throw new ConfigError(`RXF_TRUSTED_PROXIES must list IP addresses or CIDRs, got "${value}"`);
    }
    return value;
  });
}

/** https everywhere; plain http only for localhost, which browsers treat as a secure context. */
function parsePublicOrigin(raw: string | undefined, production: boolean): string {
  if (!raw) {
    if (production) throw new ConfigError('RXF_PUBLIC_ORIGIN is required in production, e.g. https://admin.rxf-sys.de');
    return 'http://localhost:5173';
  }
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const localHttp = url?.protocol === 'http:' && url.hostname === 'localhost';
  if (!url || (url.protocol !== 'https:' && !localHttp) || url.origin !== raw.replace(/\/$/, '')) {
    throw new ConfigError(`RXF_PUBLIC_ORIGIN must be an https origin without path (or http://localhost), got "${raw}"`);
  }
  return url.origin;
}

/** Reads the server configuration from the environment. Defaults keep the server off the network. */
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (rawPort.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }
  const production = env.NODE_ENV === 'production';
  const masterKeyInline = env.RXF_MASTER_KEY || undefined;
  if (production && masterKeyInline) {
    throw new ConfigError('RXF_MASTER_KEY is for development only; mount the key file in production (ADR 0006)');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    version: env.RXF_VERSION ?? 'dev',
    production,
    dataDir: env.RXF_DATA_DIR ?? '/data',
    masterKeyFile: env.RXF_MASTER_KEY_FILE ?? '/run/secrets/rxf_master_key',
    masterKeyInline,
    trustedProxies: parseTrustedProxies(env.RXF_TRUSTED_PROXIES),
    publicOrigin: parsePublicOrigin(env.RXF_PUBLIC_ORIGIN || undefined, production),
  };
}
