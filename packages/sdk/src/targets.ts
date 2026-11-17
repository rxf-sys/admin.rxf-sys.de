import * as z from 'zod/mini';

/** TLS handling per target (ADR 0008, T10). A pin replaces the host name check; nothing disables TLS globally. */
export const tlsModes = ['system', 'pin-leaf', 'pin-spki', 'ca'] as const;
export type TlsMode = (typeof tlsModes)[number];

const sha256Hex = z.string().check(z.regex(/^[0-9a-f]{64}$/));

export const tlsSettings = z.object({
  mode: z.enum(tlsModes),
  /** SHA-256 of the leaf certificate (`pin-leaf`) or of its public key (`pin-spki`), lower-case hex. */
  pinSha256: z.optional(sha256Hex),
  caPem: z.optional(z.string()),
});

export type TlsSettings = z.infer<typeof tlsSettings>;

/** One allowed peer: an origin (`scheme://host:port`) plus its TLS settings. */
export interface Target {
  origin: string;
  tls: TlsSettings;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Normalises a URL to `scheme://host:port` so allowlist comparisons are exact. */
export function originOf(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const port = parsed.port || DEFAULT_PORTS[parsed.protocol];
  if (!port) throw new Error(`unsupported scheme ${parsed.protocol}`);
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
}
