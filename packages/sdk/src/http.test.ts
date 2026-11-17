import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginHttpError } from './errors.ts';
import { createHttpClient, type RequestRule } from './http.ts';
import type { Target } from './targets.ts';

const ANY_GET: RequestRule[] = [
  { method: 'GET', path: '/**' },
  { method: 'HEAD', path: '/**' },
];

let httpServer: Server;
let httpsServer: Server;
let httpUrl: string;
let httpsUrl: string;
let certPem: string;
let connections = 0;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(String((server.address() as AddressInfo).port))),
  );
}

const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
  } else if (req.url === '/big') {
    res.end('x'.repeat(5000));
  } else if (req.url === '/slow') {
    setTimeout(() => res.end('late'), 2000);
  } else {
    res.end('hello rxf');
  }
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rxf-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key'),
      '-out',
      join(dir, 'cert'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  certPem = readFileSync(join(dir, 'cert'), 'utf8');
  httpServer = createHttpServer(handler);
  httpServer.on('connection', () => connections++);
  httpsServer = createHttpsServer({ key: readFileSync(join(dir, 'key')), cert: certPem }, handler);
  httpUrl = `http://127.0.0.1:${await listen(httpServer)}`;
  httpsUrl = `https://127.0.0.1:${await listen(httpsServer)}`;
});

afterAll(() => {
  httpServer.close();
  httpsServer.close();
});

function client(targets: Target[], extra: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({ targets, requests: ANY_GET, timeoutMs: 1000, allowBlockedAddresses: true, ...extra });
}

const plain = (): Target[] => [{ origin: httpUrl, tls: { mode: 'system' } }];

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PluginHttpError);
  return (error as PluginHttpError).code;
}

describe('createHttpClient allowlists', () => {
  it('answers allowed requests with status, body and duration', async () => {
    const http = client(plain());
    const res = await http.request('GET', `${httpUrl}/status`);
    expect(res).toMatchObject({ status: 200, body: 'hello rxf' });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    await http.close();
  });

  it('refuses origins outside the targets before connecting', async () => {
    const http = client(plain());
    const before = connections;
    expect(await codeOf(http.request('GET', httpUrl.replace('127.0.0.1', 'localhost')))).toBe('TARGET_NOT_ALLOWED');
    expect(await codeOf(http.request('GET', 'ftp://127.0.0.1/x'))).toBe('TARGET_NOT_ALLOWED');
    expect(connections).toBe(before);
    await http.close();
  });

  it('refuses requests outside the rules', async () => {
    const http = createHttpClient({
      targets: plain(),
      requests: [{ method: 'GET', path: '/api2/json/nodes/*/status' }],
      timeoutMs: 1000,
      allowBlockedAddresses: true,
    });
    expect((await http.request('GET', `${httpUrl}/api2/json/nodes/pve/status`)).status).toBe(200);
    expect(await codeOf(http.request('GET', `${httpUrl}/api2/json/nodes/pve/qemu`))).toBe('REQUEST_NOT_ALLOWED');
    expect(await codeOf(http.request('HEAD', `${httpUrl}/api2/json/nodes/pve/status`))).toBe('REQUEST_NOT_ALLOWED');
    expect(await codeOf(http.request('GET', `${httpUrl}/api2/json/nodes/pve/../../access`))).toBe(
      'REQUEST_NOT_ALLOWED',
    );
    for (const encoded of ['a%2Fb', 'a%5cb']) {
      const url = `${httpUrl}/api2/json/nodes/${encoded}/status`;
      expect(await codeOf(http.request('GET', url))).toBe('REQUEST_NOT_ALLOWED');
    }
    await http.close();
  });
});

describe('createHttpClient address guard', () => {
  it('blocks loopback by default, as a literal and via DNS (rebinding)', async () => {
    const literal = client(plain(), { allowBlockedAddresses: false });
    expect(await codeOf(literal.request('GET', `${httpUrl}/`))).toBe('TARGET_BLOCKED');
    const port = new URL(httpUrl).port;
    const rebinding = createHttpClient({
      targets: [{ origin: `http://devices.example:${port}`, tls: { mode: 'system' } }],
      requests: ANY_GET,
      timeoutMs: 1000,
      lookup: ((_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }])) as never,
    });
    expect(await codeOf(rebinding.request('GET', `http://devices.example:${port}/`))).toBe('TARGET_BLOCKED');
    await literal.close();
    await rebinding.close();
  });

  it('blocks cloud metadata addresses', async () => {
    const http = createHttpClient({
      targets: [{ origin: 'http://169.254.169.254', tls: { mode: 'system' } }],
      requests: ANY_GET,
      timeoutMs: 500,
    });
    expect(await codeOf(http.request('GET', 'http://169.254.169.254/latest/meta-data'))).toBe('TARGET_BLOCKED');
    await http.close();
  });

  it('does not follow redirects', async () => {
    const http = client(plain());
    const res = await http.request('GET', `${httpUrl}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('169.254.169.254');
    await http.close();
  });

  it('caps the body and times out', async () => {
    const http = client(plain(), { maxBodyBytes: 100 });
    expect((await http.request('GET', `${httpUrl}/big`)).body).toHaveLength(100);
    expect(await codeOf(http.request('GET', `${httpUrl}/slow`))).toBe('HTTP_TIMEOUT');
    await http.close();
  });

  it('applies a shorter per-request timeout and an abort signal', async () => {
    const http = client(plain(), { timeoutMs: 5_000 });
    const started = performance.now();
    expect(await codeOf(http.request('GET', `${httpUrl}/slow`, { timeoutMs: 100 }))).toBe('HTTP_TIMEOUT');
    expect(performance.now() - started).toBeLessThan(1_500);
    const controller = new AbortController();
    const pending = codeOf(http.request('GET', `${httpUrl}/slow`, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toBe('HTTP_TIMEOUT');
    await http.close();
  });

  it('reports refused connections', async () => {
    const http = client([{ origin: 'http://127.0.0.1:1', tls: { mode: 'system' } }]);
    expect(await codeOf(http.request('GET', 'http://127.0.0.1:1/'))).toBe('CONNECTION_REFUSED');
    await http.close();
  });
});

describe('createHttpClient TLS modes', () => {
  it('refuses a self-signed certificate under the system trust store', async () => {
    const http = client([{ origin: httpsUrl, tls: { mode: 'system' } }]);
    expect(await codeOf(http.request('GET', `${httpsUrl}/`))).toBe('TLS_SELF_SIGNED');
    await http.close();
  });

  it('shows the certificate for confirmation and accepts the confirmed pin', async () => {
    const inspect = client([{ origin: httpsUrl, tls: { mode: 'system' } }]);
    const info = await inspect.inspectTls(httpsUrl);
    expect(info).toMatchObject({ trusted: false, subject: 'CN=localhost' });
    expect(info.leafSha256).toMatch(/^[0-9a-f]{64}$/);
    await inspect.close();

    for (const tls of [
      { mode: 'pin-leaf' as const, pinSha256: info.leafSha256 },
      { mode: 'pin-spki' as const, pinSha256: info.spkiSha256 },
    ]) {
      const http = client([{ origin: httpsUrl, tls }]);
      expect((await http.request('GET', `${httpsUrl}/`)).body).toBe('hello rxf');
      await http.close();
    }
  });

  it('refuses a certificate that does not match the pin', async () => {
    const http = client([{ origin: httpsUrl, tls: { mode: 'pin-leaf', pinSha256: '0'.repeat(64) } }]);
    expect(await codeOf(http.request('GET', `${httpsUrl}/`))).toBe('TLS_PIN_MISMATCH');
    await http.close();
  });

  it('trusts a configured CA', async () => {
    const http = client([{ origin: httpsUrl, tls: { mode: 'ca', caPem: certPem } }]);
    expect((await http.request('GET', `${httpsUrl}/`)).status).toBe(200);
    await http.close();
  });

  it('inspects default-port targets on port 443', async () => {
    const asked: number[] = [];
    const net = await import('node:net');
    // Accept the TCP connection on 443's behalf: tls.connect asks the lookup, then connects to the returned port.
    const http = createHttpClient({
      targets: [{ origin: 'https://device.example', tls: { mode: 'system' } }],
      requests: ANY_GET,
      timeoutMs: 500,
      allowBlockedAddresses: true,
      lookup: ((_h: string, _o: unknown, cb: (...args: unknown[]) => void) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }])) as never,
    });
    const original = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: import('node:net').Socket, ...args: unknown[]) {
      const opts = args[0] as { port?: number };
      if (typeof opts === 'object' && opts?.port !== undefined) asked.push(Number(opts.port));
      return original.apply(this, args as never);
    } as typeof original;
    try {
      await http.inspectTls('https://device.example/').catch(() => undefined);
    } finally {
      net.Socket.prototype.connect = original;
      await http.close();
    }
    expect(asked).toContain(443);
  });

  it('inspects only https targets of the instance', async () => {
    const http = client(plain());
    expect(await codeOf(http.inspectTls(httpUrl))).toBe('TARGET_NOT_ALLOWED');
    expect(await codeOf(http.inspectTls(httpsUrl))).toBe('TARGET_NOT_ALLOWED');
    await http.close();
  });
});
