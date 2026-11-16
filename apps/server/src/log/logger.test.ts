import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.ts';

/** Known secrets that must never show up in any log line (ADR 0006). */
const SECRETS = [
  'hunter2hunter2',
  'cfut_LiveToken123',
  'tskey-auth-kSecret-XYZ',
  'PVEAPIToken=rxf@pve!monitor=0f1e2d3c',
  'eyJhbGciOiJIUzI1NiJ9.secretpayload.sig',
  'session-cookie-value',
  'query-token-value',
];

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

describe('logger redaction', () => {
  it('keeps known secrets out of every log path', async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: loggerOptions({ level: 'debug', stream }) });
    app.get('/api/fail', async () => {
      const error = new Error('device answered 401 for PVEAPIToken=rxf@pve!monitor=0f1e2d3c') as Error & {
        headers?: Record<string, string>;
      };
      error.headers = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.sig' };
      throw error;
    });
    await app.ready();

    app.log.info({ password: 'hunter2hunter2', instance: { tokenSecret: 'cfut_LiveToken123' } }, 'saving instance');
    app.log.warn('rotating tskey-auth-kSecret-XYZ');
    app.log.error({ err: { reason: 'cfut_LiveToken123' } }, 'plain object as err');
    app.log.error({ err: 'string error with Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.sig' }, 'string as err');
    app.log.error({ err: new Error('Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.sig rejected') }, 'probe failed');
    await app.inject({
      method: 'GET',
      url: '/api/fail?token=query-token-value',
      headers: { cookie: '__Host-rxf_session=session-cookie-value' },
    });
    await app.close();

    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(4);
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    expect(output).toContain('[redacted]');
    expect(output).toContain('"url":"/api/fail"');
  });
});
