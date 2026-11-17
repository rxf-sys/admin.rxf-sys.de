import { type HttpClient, type PluginContext, PluginHttpError } from '@rxf/sdk';
import { describe, expect, it } from 'vitest';
import plugin, { type UptimeCheck } from './index.ts';
import { statusMatches } from './status.ts';

type Config = Parameters<typeof plugin.test>[0]['config'];

function ctx(
  checks: UptimeCheck[],
  answer: (url: string) => Promise<{ status: number; durationMs: number }>,
): PluginContext<Config> {
  const http: HttpClient = {
    request: async (_method, url) => ({ ...(await answer(url)), headers: {}, body: '' }),
    inspectTls: async (origin) => ({
      origin,
      leafSha256: 'a'.repeat(64),
      spkiSha256: 'b'.repeat(64),
      subject: 'CN=pve',
      issuer: 'CN=pve',
      subjectAltName: null,
      validTo: 'Jan 1 00:00:00 2030 GMT',
      trusted: false,
    }),
    close: async () => {},
  };
  const log = { info() {}, warn() {}, error() {} };
  return {
    config: { checks, slowThresholdMs: 800, allowBlockedTargets: false },
    secrets: {},
    http,
    log,
    now: () => 0,
    signal: new AbortController().signal,
  };
}

describe('statusMatches', () => {
  it.each([
    ['200-399,401,403,405', 204, true],
    ['200-399,401,403,405', 401, true],
    ['200-399,401,403,405', 404, false],
    ['200-399,401,403,405', 500, false],
    ['200', 200, true],
  ])('%s with %i → %s', (expected, status, result) => {
    expect(statusMatches(expected, status)).toBe(result);
  });
});

describe('uptime targets', () => {
  it('lists each origin once with its TLS settings', () => {
    const targets = plugin.targets({
      slowThresholdMs: 800,
      allowBlockedTargets: false,
      checks: [
        { name: 'a', url: 'https://pve.lan:8006/', tlsMode: 'pin-leaf', pinSha256: 'c'.repeat(64) },
        { name: 'b', url: 'https://pve.lan:8006/api2/json/version' },
        { name: 'c', url: 'http://192.168.2.1/' },
      ],
    });
    expect(targets).toEqual([
      { origin: 'https://pve.lan:8006', tls: { mode: 'pin-leaf', pinSha256: 'c'.repeat(64) } },
      { origin: 'http://192.168.2.1:80', tls: { mode: 'system' } },
    ]);
  });
});

describe('uptime test()', () => {
  it('reports each check; a service that is down does not fail the test', async () => {
    const result = await plugin.test(
      ctx(
        [
          { name: 'fast', url: 'http://a.lan/' },
          { name: 'slow', url: 'http://b.lan/' },
          { name: 'down', url: 'http://c.lan/' },
          { name: 'refused', url: 'http://d.lan/' },
        ],
        async (url) => {
          if (url.includes('d.lan')) throw new PluginHttpError('CONNECTION_REFUSED', 'refused');
          if (url.includes('c.lan')) return { status: 503, durationMs: 10 };
          return { status: 200, durationMs: url.includes('b.lan') ? 1200 : 20 };
        },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.capabilities).toEqual([
      { id: 'check:fast', status: 'ok', message: 'HTTP 200, 20 ms' },
      { id: 'check:slow', status: 'ok', code: 'HTTP_SLOW', message: '1200 ms' },
      { id: 'check:down', status: 'failed', code: 'HTTP_STATUS', message: 'HTTP 503' },
      { id: 'check:refused', status: 'failed', code: 'CONNECTION_REFUSED', message: 'refused' },
    ]);
  });

  it('fails on configuration errors and shows the certificate of a self-signed target', async () => {
    const result = await plugin.test(
      ctx([{ name: 'pve', url: 'https://pve.lan:8006/' }], async () => {
        throw new PluginHttpError('TLS_SELF_SIGNED', 'untrusted');
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.tls?.[0]).toMatchObject({ origin: 'https://pve.lan:8006/', leafSha256: 'a'.repeat(64) });
  });

  it('honours a custom expected status and HEAD', async () => {
    const seen: string[] = [];
    const result = await plugin.test(
      ctx([{ name: 'api', url: 'http://e.lan/health', method: 'HEAD', expectedStatus: '204' }], async (url) => {
        seen.push(url);
        return { status: 200, durationMs: 5 };
      }),
    );
    expect(result.capabilities[0]).toMatchObject({ status: 'failed', code: 'HTTP_STATUS' });
    expect(seen).toEqual(['http://e.lan/health']);
  });

  it('rejects invalid check definitions', () => {
    const parse = (c: unknown) =>
      plugin.config.schema.safeParse({ checks: [c], slowThresholdMs: 800, allowBlockedTargets: false }).success;
    expect(parse({ name: 'x', url: 'ftp://host/' })).toBe(false);
    expect(parse({ name: 'x', url: 'http://host/', expectedStatus: '2xx' })).toBe(false);
    expect(parse({ name: '', url: 'http://host/' })).toBe(false);
    expect(parse({ name: 'x', url: 'http://host/', expectedStatus: '200-299,401' })).toBe(true);
  });
});
