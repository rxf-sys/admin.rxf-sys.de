import { type Collector, type HttpClient, type NetClient, type PluginContext, PluginHttpError } from '@rxf/sdk';
import { describe, expect, it } from 'vitest';
import { statusMatches } from '../shared/status.ts';
import plugin, { type UptimeCheck } from './index.ts';

type Config = Parameters<typeof plugin.test>[0]['config'];

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const unexpected = async (): Promise<never> => {
  throw new Error('unexpected probe');
};
const noNet: NetClient = { tcp: unexpected, tls: unexpected, dns: unexpected, ping: unexpected };

function collectors(checks: UptimeCheck[]): Collector<Config>[] {
  const list = plugin.collectors;
  if (typeof list !== 'function') throw new Error('uptime derives its collectors from the config');
  return list({ checks, slowThresholdMs: 800, allowBlockedTargets: false });
}

const requests: { url: string; timeoutMs: number | undefined; signal: boolean }[] = [];

function ctx(
  checks: UptimeCheck[],
  answer: (url: string) => Promise<{ status: number; durationMs: number }>,
  net: Partial<NetClient> = {},
): PluginContext<Config> {
  const http: HttpClient = {
    request: async (_method, url, init) => {
      requests.push({ url, timeoutMs: init?.timeoutMs, signal: init?.signal !== undefined });
      return { ...(await answer(url)), headers: {}, body: '' };
    },
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
    net: { ...noNet, ...net },
    log,
    now: () => NOW,
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
      { id: 'check:slow', status: 'ok', code: 'HTTP_SLOW', message: 'HTTP 200, 1200 ms' },
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
    expect(result.tls?.[0]).toMatchObject({ origin: 'https://pve.lan:8006', leafSha256: 'a'.repeat(64) });
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
    const twice = { name: 'x', url: 'http://host/' };
    expect(
      plugin.config.schema.safeParse({ checks: [twice, twice], slowThresholdMs: 800, allowBlockedTargets: false })
        .success,
    ).toBe(false);
  });
});

describe('uptime collector', () => {
  const [collector] = collectors([{ name: 'x', url: 'http://a.lan/' }]);

  it('polls every 30 s while watched and every 60 s otherwise, deleting removed checks', () => {
    expect(collector).toMatchObject({
      id: 'checks',
      interval: { activeMs: 30_000, backgroundMs: 60_000 },
      onMissing: 'delete',
    });
  });

  it('turns every check into a Service entity with status and response-time series', async () => {
    requests.length = 0;
    const result = await collector?.run(
      ctx(
        [
          { name: 'fast', url: 'http://a.lan/' },
          { name: 'slow', url: 'http://b.lan/', timeoutMs: 2_000 },
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
    expect(result?.entities.map((e) => [e.externalId, e.status, e.statusReason])).toEqual([
      ['fast', 'ok', undefined],
      ['slow', 'warn', 'HTTP_SLOW'],
      ['down', 'crit', 'HTTP_STATUS'],
      ['refused', 'crit', 'CONNECTION_REFUSED'],
    ]);
    expect(result?.entities[0]).toMatchObject({
      kind: 'Service',
      name: 'fast',
      attrs: {
        type: 'http',
        endpoint: 'http://a.lan/',
        target: 'a.lan',
        method: 'GET',
        httpStatus: 200,
        responseMs: 20,
      },
    });
    expect(result?.entities[3]?.attrs).toMatchObject({ httpStatus: null, responseMs: null });
    const values = result?.metrics.map((m) => [m.entity.externalId, m.name, m.value]);
    expect(values).toEqual([
      ['fast', 'uptime.status', 1],
      ['fast', 'uptime.response_ms', 20],
      ['slow', 'uptime.status', 1],
      ['slow', 'uptime.response_ms', 1200],
      ['down', 'uptime.status', 0],
      ['down', 'uptime.response_ms', 10],
      ['refused', 'uptime.status', 0],
    ]);
    expect(result?.metrics.every((m) => m.ts === NOW)).toBe(true);
    // Per-check timeout (default 10 s) and the run's abort signal reach every request.
    expect(requests.find((r) => r.url === 'http://b.lan/')).toEqual({
      url: 'http://b.lan/',
      timeoutMs: 2_000,
      signal: true,
    });
    expect(requests.find((r) => r.url === 'http://a.lan/')?.timeoutMs).toBe(10_000);
  });

  it('lets programming errors fail the run instead of reporting the service as down', async () => {
    await expect(
      collector?.run(
        ctx([{ name: 'x', url: 'http://a.lan/' }], async () => {
          throw new TypeError('bug');
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('copes with an empty check list', async () => {
    expect(await collector?.run(ctx([], async () => ({ status: 200, durationMs: 1 })))).toEqual({
      entities: [],
      metrics: [],
    });
  });
});

describe('check types', () => {
  const answer = async () => ({ status: 200, durationMs: 1 });
  const base = { slowThresholdMs: 800, allowBlockedTargets: false };
  const parse = (c: unknown) => plugin.config.schema.safeParse({ checks: [c], ...base }).success;

  it('validates hosts, ports and DNS servers per type', () => {
    expect(parse({ type: 'tcp', name: 'ssh', host: 'pve.lan', port: 22 })).toBe(true);
    expect(parse({ type: 'tcp', name: 'ssh', host: '-oProxyCommand', port: 22 })).toBe(false);
    expect(parse({ type: 'tcp', name: 'ssh', host: 'pve.lan', port: 70_000 })).toBe(false);
    expect(parse({ type: 'icmp', name: 'gw', host: '192.168.2.1', count: 3 })).toBe(true);
    expect(parse({ type: 'icmp', name: 'gw', host: 'bad host' })).toBe(false);
    expect(parse({ type: 'dns', name: 'd', query: 'rxf-sys.de', recordType: 'MX', server: '1.1.1.1' })).toBe(true);
    expect(parse({ type: 'dns', name: 'd', query: 'rxf-sys.de', server: 'dns.google' })).toBe(false);
    expect(parse({ type: 'tls', name: 't', host: 'rxf-sys.de', warnDays: 30, critDays: 7 })).toBe(true);
    expect(parse({ type: 'smtp', name: 'x', host: 'a' })).toBe(false);
    expect(parse({ name: 'x', url: 'http://a/', intervalS: 5 })).toBe(false);
  });

  it('lists one target per peer, none for a DNS check on the system resolver', () => {
    const targets = plugin.targets({
      ...base,
      checks: [
        { type: 'tcp', name: 'ssh', host: 'PVE.lan', port: 22 },
        { type: 'icmp', name: 'v6', host: 'fd00::1' },
        { type: 'dns', name: 'sys', query: 'rxf-sys.de' },
        { type: 'dns', name: 'own', query: 'rxf-sys.de', server: '192.168.2.1' },
        { type: 'tls', name: 'cert', host: 'rxf-sys.de', tlsMode: 'pin-spki', pinSha256: 'd'.repeat(64) },
      ],
    });
    expect(targets).toEqual([
      { origin: 'tcp://pve.lan:22', tls: { mode: 'system' } },
      { origin: 'icmp://[fd00::1]', tls: { mode: 'system' } },
      { origin: 'dns://192.168.2.1:53', tls: { mode: 'system' } },
      { origin: 'tls://rxf-sys.de:443', tls: { mode: 'pin-spki', pinSha256: 'd'.repeat(64) } },
    ]);
  });

  it('groups checks by interval', () => {
    const list = collectors([
      { name: 'a', url: 'http://a/' },
      { name: 'b', url: 'http://b/', intervalS: 300 },
      { type: 'tcp', name: 'c', host: 'c', port: 1, intervalS: 15 },
      { name: 'd', url: 'http://d/', intervalS: 300 },
    ]);
    expect(list.map((c) => [c.id, c.interval.activeMs, c.interval.backgroundMs])).toEqual([
      ['checks', 30_000, 60_000],
      ['checks-15s', 15_000, 15_000],
      ['checks-300s', 300_000, 300_000],
    ]);
    expect(collectors([])).toEqual([]);
  });

  it('runs only the checks of its own interval', async () => {
    const checks: UptimeCheck[] = [
      { name: 'a', url: 'http://a/' },
      { name: 'b', url: 'http://b/', intervalS: 300 },
    ];
    const slow = collectors(checks).find((c) => c.id === 'checks-300s');
    const result = await slow?.run(ctx(checks, answer));
    expect(result?.entities.map((e) => e.externalId)).toEqual(['b']);
  });

  it('measures TCP connections', async () => {
    const checks: UptimeCheck[] = [
      { type: 'tcp', name: 'ok', host: 'a.lan', port: 22 },
      { type: 'tcp', name: 'slow', host: 'b.lan', port: 22 },
      { type: 'tcp', name: 'closed', host: 'c.lan', port: 22, timeoutMs: 1000 },
    ];
    const seen: [string, number | undefined][] = [];
    const [run] = collectors(checks);
    const result = await run?.run(
      ctx(checks, answer, {
        tcp: async (origin, init) => {
          seen.push([origin, init?.timeoutMs]);
          if (origin.includes('c.lan')) throw new PluginHttpError('CONNECTION_REFUSED', 'refused');
          return { durationMs: origin.includes('b.lan') ? 900 : 3 };
        },
      }),
    );
    expect(result?.entities.map((e) => [e.externalId, e.status, e.statusReason, e.attrs?.target])).toEqual([
      ['ok', 'ok', undefined, 'a.lan:22'],
      ['slow', 'warn', 'TCP_SLOW', 'b.lan:22'],
      ['closed', 'crit', 'CONNECTION_REFUSED', 'c.lan:22'],
    ]);
    expect(seen).toContainEqual(['tcp://c.lan:22', 1000]);
    expect(seen).toContainEqual(['tcp://a.lan:22', 10_000]);
  });

  it('pings, reports loss and leaves the status open when the container may not ping', async () => {
    const checks: UptimeCheck[] = [
      { type: 'icmp', name: 'ok', host: 'a.lan' },
      { type: 'icmp', name: 'lossy', host: 'b.lan' },
      { type: 'icmp', name: 'silent', host: 'c.lan' },
      { type: 'icmp', name: 'denied', host: 'd.lan' },
    ];
    const [run] = collectors(checks);
    const result = await run?.run(
      ctx(checks, answer, {
        ping: async (origin) => {
          if (origin.includes('b.lan')) return { sent: 4, received: 3, avgMs: 2 };
          if (origin.includes('c.lan')) throw new PluginHttpError('ICMP_NO_REPLY', 'no reply');
          if (origin.includes('d.lan')) throw new PluginHttpError('ICMP_UNAVAILABLE', 'not permitted');
          return { sent: 3, received: 3, avgMs: 0.4 };
        },
      }),
    );
    expect(result?.entities.map((e) => [e.externalId, e.status, e.statusReason])).toEqual([
      ['ok', 'ok', undefined],
      ['lossy', 'warn', 'ICMP_LOSS'],
      ['silent', 'crit', 'ICMP_NO_REPLY'],
      ['denied', 'unknown', 'ICMP_UNAVAILABLE'],
    ]);
    const metrics = result?.metrics.map((m) => `${m.entity.externalId} ${m.name} ${m.value}`);
    expect(metrics).toEqual([
      'ok uptime.status 1',
      'ok uptime.response_ms 0.4',
      'ok uptime.loss_pct 0',
      'lossy uptime.status 1',
      'lossy uptime.response_ms 2',
      'lossy uptime.loss_pct 25',
      'silent uptime.status 0',
      'silent uptime.loss_pct 100',
    ]);
  });

  it('resolves names and compares the expected answer', async () => {
    const checks: UptimeCheck[] = [
      { type: 'dns', name: 'match', query: 'rxf-sys.de', expected: '192.0.2.10' },
      { type: 'dns', name: 'wrong', query: 'rxf-sys.de', server: '192.168.2.1', expected: '192.0.2.99' },
      { type: 'dns', name: 'mx', query: 'rxf-sys.de', recordType: 'MX', expected: 'MAIL.rxf-sys.de' },
      { type: 'dns', name: 'gone', query: 'nope.rxf-sys.de' },
    ];
    const queries: unknown[] = [];
    const [run] = collectors(checks);
    const result = await run?.run(
      ctx(checks, answer, {
        dns: async (query) => {
          queries.push(query);
          if (query.name.startsWith('nope')) throw new PluginHttpError('DNS_NOT_FOUND', 'no record');
          return { records: query.type === 'MX' ? ['mail.rxf-sys.de'] : ['192.0.2.10'], durationMs: 4 };
        },
      }),
    );
    expect(result?.entities.map((e) => [e.externalId, e.status, e.statusReason])).toEqual([
      ['match', 'ok', undefined],
      ['wrong', 'crit', 'DNS_MISMATCH'],
      ['mx', 'ok', undefined],
      ['gone', 'crit', 'DNS_NOT_FOUND'],
    ]);
    expect(result?.entities[1]?.attrs).toMatchObject({ target: 'rxf-sys.de (A)', records: ['192.0.2.10'] });
    expect(queries[1]).toEqual({ name: 'rxf-sys.de', type: 'A', server: 'dns://192.168.2.1:53' });
    expect(queries[0]).toEqual({ name: 'rxf-sys.de', type: 'A' });
  });

  it('turns the certificate end date into days left and thresholds', async () => {
    const days = { fresh: 90, soon: 10, close: 3, past: -1 } as Record<string, number>;
    const checks: UptimeCheck[] = [
      ...Object.keys(days).map((name) => ({ type: 'tls' as const, name, host: `${name}.lan` })),
      { type: 'tls', name: 'bad', host: 'bad.lan', servername: 'other.lan' },
    ];
    const seen: unknown[] = [];
    const [run] = collectors(checks);
    const result = await run?.run(
      ctx(checks, answer, {
        tls: async (origin, init) => {
          seen.push(init?.servername);
          const name = new URL(origin).hostname.split('.')[0] as string;
          if (name === 'bad') throw new PluginHttpError('TLS_HOSTNAME', 'wrong name');
          const info = {
            origin,
            leafSha256: 'a'.repeat(64),
            spkiSha256: 'b'.repeat(64),
            subject: 'CN=x',
            issuer: 'CN=R11',
            subjectAltName: null,
            validTo: '',
            trusted: true,
          };
          return { durationMs: 12, info, validToMs: NOW + (days[name] as number) * DAY + 1000 };
        },
      }),
    );
    expect(result?.entities.map((e) => [e.externalId, e.status, e.statusReason, e.attrs?.daysLeft])).toEqual([
      ['fresh', 'ok', undefined, 90],
      ['soon', 'warn', 'TLS_EXPIRING', 10],
      ['close', 'crit', 'TLS_EXPIRING', 3],
      ['past', 'crit', 'TLS_EXPIRED', -1],
      ['bad', 'crit', 'TLS_HOSTNAME', undefined],
    ]);
    expect(seen.at(-1)).toBe('other.lan');
    expect(
      result?.metrics.find((m) => m.entity.externalId === 'soon' && m.name === 'uptime.tls_days_left')?.value,
    ).toBe(10);
  });

  it('test() marks ping as unsupported and offers the certificate of a TLS check', async () => {
    const result = await plugin.test(
      ctx(
        [
          { type: 'icmp', name: 'gw', host: 'gw.lan' },
          { type: 'tls', name: 'nas', host: 'nas.lan', port: 5001 },
        ],
        answer,
        {
          ping: async () => {
            throw new PluginHttpError('ICMP_UNAVAILABLE', 'not permitted');
          },
          tls: async () => {
            throw new PluginHttpError('TLS_SELF_SIGNED', 'untrusted');
          },
        },
      ),
    );
    expect(result.capabilities.map((c) => [c.id, c.status, c.code])).toEqual([
      ['check:gw', 'unsupported', 'ICMP_UNAVAILABLE'],
      ['check:nas', 'failed', 'TLS_SELF_SIGNED'],
    ]);
    expect(result.ok).toBe(false);
    expect(result.tls?.[0]?.origin).toBe('tls://nas.lan:5001');
  });

  it('test() still answers when the certificate cannot be read', async () => {
    const context = ctx([{ name: 'pve', url: 'https://pve.lan:8006/' }], async () => {
      throw new PluginHttpError('TLS_SELF_SIGNED', 'untrusted');
    });
    context.http.inspectTls = async () => {
      throw new PluginHttpError('HTTP_TIMEOUT', 'gone');
    };
    const result = await plugin.test(context);
    expect(result).toEqual({
      ok: false,
      capabilities: [{ id: 'check:pve', status: 'failed', code: 'TLS_SELF_SIGNED', message: 'untrusted' }],
    });
  });
});

describe('review follow-ups', () => {
  it('reads the certificate for pinning with the SNI name the check uses', async () => {
    const seen: [string, unknown][] = [];
    const context = ctx(
      [{ type: 'tls', name: 'nas', host: '192.168.2.5', servername: 'nas.lan' }],
      async () => ({
        status: 200,
        durationMs: 1,
      }),
      {
        tls: async () => {
          throw new PluginHttpError('TLS_SELF_SIGNED', 'untrusted');
        },
      },
    );
    const inspect = context.http.inspectTls;
    context.http.inspectTls = async (origin, init) => {
      seen.push([origin, init]);
      return inspect(origin);
    };
    await plugin.test(context);
    expect(seen).toEqual([['tls://192.168.2.5:443', { servername: 'nas.lan' }]]);
  });

  it('rejects IPv6 zone ids, which targets() could not list', () => {
    const parse = (c: unknown) =>
      plugin.config.schema.safeParse({ checks: [c], slowThresholdMs: 800, allowBlockedTargets: false }).success;
    expect(parse({ type: 'icmp', name: 'll', host: 'fe80::1%eth0' })).toBe(false);
    expect(parse({ type: 'dns', name: 'd', query: 'a.lan', server: 'fe80::1%eth0' })).toBe(false);
    expect(parse({ type: 'icmp', name: 'v6', host: 'fd00::1' })).toBe(true);
  });
});
