import type { PluginConfig, TlsCertificate } from '@rxf/web-sdk';

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Same normalisation as the SDK's `originOf` (scheme://host:port), without importing server code. */
function originOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  const port = parsed.port || DEFAULT_PORTS[parsed.protocol];
  return port ? `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}` : null;
}

/**
 * Pins the confirmed leaf certificate on every check of that origin (ADR 0008, trust on first use). The pin
 * replaces the hostname check, which self-signed devices addressed by IP would fail anyway.
 */
export function trustCertificate(config: PluginConfig, certificate: TlsCertificate): PluginConfig {
  const checks = Array.isArray(config.checks) ? (config.checks as Record<string, unknown>[]) : [];
  const target = originOf(certificate.origin);
  return {
    ...config,
    checks: checks.map((check) =>
      typeof check.url === 'string' && originOf(check.url) === target
        ? { ...check, tlsMode: 'pin-leaf', pinSha256: certificate.leafSha256 }
        : check,
    ),
  };
}
