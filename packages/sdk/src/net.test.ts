import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, readFileSync } from 'node:fs';
import { type AddressInfo, createServer, type LookupFunction, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginHttpError } from './errors.ts';
import { createNetClient, type NetClientOptions, type PingRunner, parsePing } from './net.ts';
import type { Target } from './targets.ts';

let tcpServer: Server;
let tlsServer: Server;
let dnsServer: UdpSocket;
let tcpPort: number;
let closedPort: number;
let tlsPort: number;
let dnsPort: number;
let certPem: string;
let leafSha256: string;

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

/** Answers every A query with 192.0.2.10 and every other type with NXDOMAIN. */
function dnsAnswer(query: Buffer): Buffer {
  let offset = 12;
  while (query[offset] !== 0) offset += (query[offset] as number) + 1;
  const questionEnd = offset + 5;
  const type = query.readUInt16BE(offset + 1);
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(type === 1 ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(type === 1 ? 1 : 0, 6);
  const question = query.subarray(12, questionEnd);
  if (type !== 1) return Buffer.concat([header, question]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 10]);
  return Buffer.concat([header, question, answer]);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rxf-net-'));
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
      '30',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  certPem = readFileSync(join(dir, 'cert'), 'utf8');
  leafSha256 = createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');
  tcpServer = createServer((socket) => socket.end());
  tcpPort = await listen(tcpServer);
  const probe = createServer();
  closedPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  tlsServer = createTlsServer({ key: readFileSync(join(dir, 'key')), cert: certPem }, (socket) => socket.end());
  tlsPort = await listen(tlsServer);
  dnsServer = createSocket('udp4');
  dnsServer.on('message', (message, remote) => dnsServer.send(dnsAnswer(message), remote.port, remote.address));
  await new Promise<void>((resolve) => dnsServer.bind(0, '127.0.0.1', resolve));
  dnsPort = dnsServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => tcpServer.close(resolve));
  await new Promise((resolve) => tlsServer.close(resolve));
  dnsServer.close();
});

const tls = (overrides: Partial<Target['tls']> = {}): Target['tls'] => ({ mode: 'system', ...overrides });

function client(targets: Target[], extra: Partial<NetClientOptions> = {}) {
  return createNetClient({ targets, timeoutMs: 2000, allowBlockedAddresses: true, ...extra });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PluginHttpError);
    return (error as PluginHttpError).code;
  }
  throw new Error('expected a rejection');
}

describe('tcp', () => {
  it('connects to an allowed target', async () => {
    const origin = `tcp://127.0.0.1:${tcpPort}`;
    const result = await client([{ origin, tls: tls() }]).tcp(origin);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a closed port', async () => {
    const origin = `tcp://127.0.0.1:${closedPort}`;
    expect(await codeOf(client([{ origin, tls: tls() }]).tcp(origin))).toBe('CONNECTION_REFUSED');
  });

  it('refuses origins that are not targets', async () => {
    const net = client([{ origin: `tcp://127.0.0.1:${tcpPort}`, tls: tls() }]);
    expect(await codeOf(net.tcp(`tcp://127.0.0.1:${closedPort}`))).toBe('TARGET_NOT_ALLOWED');
    expect(await codeOf(net.tcp(`tls://127.0.0.1:${tcpPort}`))).toBe('TARGET_NOT_ALLOWED');
  });

  it('blocks loopback unless the instance allows it, also behind a host name', async () => {
    const origin = `tcp://127.0.0.1:${tcpPort}`;
    const blocked = client([{ origin, tls: tls() }], { allowBlockedAddresses: false });
    expect(await codeOf(blocked.tcp(origin))).toBe('TARGET_BLOCKED');
    const named = `tcp://rebind.example:${tcpPort}`;
    const lookup: LookupFunction = (_host, _options, callback) =>
      (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ]);
    const rebinding = client([{ origin: named, tls: tls() }], { allowBlockedAddresses: false, lookup });
    expect(await codeOf(rebinding.tcp(named))).toBe('TARGET_BLOCKED');
  });

  it('turns an abort into a timeout', async () => {
    const origin = `tcp://127.0.0.1:${tcpPort}`;
    expect(await codeOf(client([{ origin, tls: tls() }]).tcp(origin, { signal: AbortSignal.abort() }))).toBe(
      'CONNECT_TIMEOUT',
    );
  });
});

describe('tls', () => {
  const origin = () => `tls://127.0.0.1:${tlsPort}`;

  it('rejects a self-signed certificate in system mode', async () => {
    expect(await codeOf(client([{ origin: origin(), tls: tls() }]).tls(origin()))).toBe('TLS_SELF_SIGNED');
  });

  it('accepts it with its own CA and reports the end date', async () => {
    const result = await client([{ origin: origin(), tls: tls({ mode: 'ca', caPem: certPem }) }]).tls(origin());
    expect(result.info.leafSha256).toBe(leafSha256);
    expect(result.validToMs - Date.now()).toBeGreaterThan(28 * 86_400_000);
  });

  it('checks the host name against the certificate', async () => {
    const net = client([{ origin: origin(), tls: tls({ mode: 'ca', caPem: certPem }) }]);
    expect(await codeOf(net.tls(origin(), { servername: 'other.example' }))).toBe('TLS_HOSTNAME');
  });

  it('compares pins', async () => {
    const good = client([{ origin: origin(), tls: tls({ mode: 'pin-leaf', pinSha256: leafSha256 }) }]);
    expect((await good.tls(origin())).info.leafSha256).toBe(leafSha256);
    const bad = client([{ origin: origin(), tls: tls({ mode: 'pin-leaf', pinSha256: '0'.repeat(64) }) }]);
    expect(await codeOf(bad.tls(origin()))).toBe('TLS_PIN_MISMATCH');
  });

  it('reports a closed port and an abort', async () => {
    const closed = `tls://127.0.0.1:${closedPort}`;
    expect(await codeOf(client([{ origin: closed, tls: tls() }]).tls(closed))).toBe('CONNECTION_REFUSED');
    const net = client([{ origin: origin(), tls: tls() }]);
    expect(await codeOf(net.tls(origin(), { signal: AbortSignal.abort() }))).toBe('CONNECT_TIMEOUT');
  });
});

describe('dns', () => {
  const server = () => `dns://127.0.0.1:${dnsPort}`;

  it('resolves through an allowed server', async () => {
    const net = client([{ origin: server(), tls: tls() }]);
    const result = await net.dns({ name: 'nas.example', type: 'A', server: server() });
    expect(result.records).toEqual(['192.0.2.10']);
  });

  it('maps a missing record', async () => {
    const net = client([{ origin: server(), tls: tls() }]);
    expect(await codeOf(net.dns({ name: 'nas.example', type: 'MX', server: server() }))).toBe('DNS_NOT_FOUND');
  });

  it('refuses servers that are not targets or are blocked', async () => {
    const net = client([{ origin: server(), tls: tls() }]);
    expect(await codeOf(net.dns({ name: 'a.example', type: 'A', server: 'dns://192.0.2.53' }))).toBe(
      'TARGET_NOT_ALLOWED',
    );
    const blocked = client([{ origin: server(), tls: tls() }], { allowBlockedAddresses: false });
    expect(await codeOf(blocked.dns({ name: 'a.example', type: 'A', server: server() }))).toBe('TARGET_BLOCKED');
    const named = client([{ origin: 'dns://resolver.example:53', tls: tls() }]);
    expect(await codeOf(named.dns({ name: 'a.example', type: 'A', server: 'dns://resolver.example' }))).toBe(
      'TARGET_NOT_ALLOWED',
    );
  });

  it('reports a server that does not answer', async () => {
    const silent = createSocket('udp4');
    await new Promise<void>((resolve) => silent.bind(0, '127.0.0.1', resolve));
    const origin = `dns://127.0.0.1:${silent.address().port}`;
    try {
      const net = client([{ origin, tls: tls() }]);
      expect(await codeOf(net.dns({ name: 'a.example', type: 'A', server: origin }, { timeoutMs: 300 }))).toBe(
        'DNS_TIMEOUT',
      );
    } finally {
      silent.close();
    }
  });
});

describe('ping', () => {
  const reply = `PING 192.0.2.7 (192.0.2.7) 56(84) bytes of data.
64 bytes from 192.0.2.7: icmp_seq=1 ttl=64 time=0.412 ms

--- 192.0.2.7 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 402ms
rtt min/avg/max/mdev = 0.398/0.437/0.501/0.045 ms
`;
  const target = { origin: 'icmp://nas.lan', tls: tls() };
  const lookup: LookupFunction = (_host, _options, callback) =>
    (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '192.0.2.7', family: 4 },
    ]);

  it('pings the resolved address without letting it pass as an option', async () => {
    const calls: (readonly string[])[] = [];
    const ping: PingRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: reply, stderr: '' };
    };
    const result = await client([target], { lookup, ping }).ping('icmp://nas.lan', { count: 3 });
    expect(result).toEqual({ sent: 3, received: 3, avgMs: 0.4 });
    expect(calls[0]?.slice(-2)).toEqual(['--', '192.0.2.7']);
  });

  it('maps lost replies, missing permissions and a missing binary', async () => {
    const run = (result: Partial<Awaited<ReturnType<PingRunner>>> | Error) => {
      const ping: PingRunner = async () => {
        if (result instanceof Error) throw result;
        return { exitCode: 1, stdout: '', stderr: '', ...result };
      };
      return client([target], { lookup, ping }).ping('icmp://nas.lan');
    };
    expect(await codeOf(run({ stdout: '3 packets transmitted, 0 received, 100% packet loss' }))).toBe('ICMP_NO_REPLY');
    expect(
      await codeOf(run({ exitCode: 2, stderr: 'ping: socktype: SOCK_RAW\nping: socket: Operation not permitted' })),
    ).toBe('ICMP_UNAVAILABLE');
    expect(await codeOf(run(Object.assign(new Error('spawn ping ENOENT'), { code: 'ENOENT' })))).toBe(
      'ICMP_UNAVAILABLE',
    );
    expect(await codeOf(run(Object.assign(new Error('killed'), { killed: true })))).toBe('CONNECT_TIMEOUT');
    expect(await codeOf(run({ exitCode: 2, stdout: 'garbage' }))).toBe('NETWORK_ERROR');
  });

  it('refuses blocked and unknown targets', async () => {
    const ping: PingRunner = async () => ({ exitCode: 0, stdout: reply, stderr: '' });
    const loopback = { origin: 'icmp://127.0.0.1', tls: tls() };
    const net = client([target, loopback], { lookup, ping, allowBlockedAddresses: false });
    expect(await codeOf(net.ping('icmp://127.0.0.1'))).toBe('TARGET_BLOCKED');
    expect(await codeOf(net.ping('icmp://other.lan'))).toBe('TARGET_NOT_ALLOWED');
  });

  it('parses partial loss', () => {
    expect(
      parsePing('4 packets transmitted, 2 received, 50% packet loss\nrtt min/avg/max/mdev = 1/2.25/3/1 ms'),
    ).toEqual({
      sent: 4,
      received: 2,
      avgMs: 2.3,
    });
  });
});
