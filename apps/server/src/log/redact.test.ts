import { describe, expect, it } from 'vitest';
import { REDACTED, redactValue, scrubText } from './redact.ts';

describe('scrubText', () => {
  it.each([
    ['Cloudflare token cfut_abc123_XYZ-9 rejected', 'Cloudflare token [redacted] rejected'],
    ['tailscale tskey-auth-k123-ABC expired', 'tailscale [redacted] expired'],
    ['Authorization: PVEAPIToken=rxf@pve!monitor=1234-abcd failed', 'Authorization: [redacted] failed'],
    ['header Bearer eyJhbGciOi.payload.sig', 'header [redacted]'],
    ['Basic dXNlcjpwYXNz', '[redacted]'],
    ['Basic setup done', 'Basic setup done'],
  ])('scrubs %j', (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubText('Backup of CT 104 is 26 hours old')).toBe('Backup of CT 104 is 26 hours old');
  });
});

describe('redactValue', () => {
  it('redacts secret keys at any depth, in arrays too', () => {
    const value = {
      user: 'admin',
      password: 'hunter2hunter2',
      config: { host: '192.168.2.200', tokenSecret: 'abc', nested: [{ apiKey: 'k1' }, { 'x-api-key': 'k2' }] },
      headers: { authorization: 'Bearer abc', cookie: '__Host-rxf_session=abc', accept: 'json' },
      setupCode: 'ABCDEFGHIJKLMNOPQRST',
    };
    expect(redactValue(value)).toEqual({
      user: 'admin',
      password: REDACTED,
      config: {
        host: '192.168.2.200',
        tokenSecret: REDACTED,
        nested: [{ apiKey: REDACTED }, { 'x-api-key': REDACTED }],
      },
      headers: { authorization: REDACTED, cookie: REDACTED, accept: 'json' },
      setupCode: REDACTED,
    });
  });

  it('keeps empty secret fields visible as empty (useful to see "not set")', () => {
    expect(redactValue({ token: null, secret: undefined })).toEqual({ token: null, secret: undefined });
  });

  it('reduces errors to safe fields, wherever they sit', () => {
    const error = Object.assign(new Error('401 for Bearer abcdefghijkl'), {
      code: 'E401',
      headers: { authorization: 'Bearer abcdefghijkl' },
    });
    const out = redactValue({ cause: error }) as { cause: Record<string, unknown> };
    expect(out.cause).toMatchObject({ type: 'Error', code: 'E401', message: '401 for [redacted]' });
    expect(out.cause).not.toHaveProperty('headers');
    expect(JSON.stringify(out)).not.toContain('abcdefghijkl');
  });

  it('leaves class instances to their serializers', () => {
    const date = new Date(0);
    expect((redactValue({ at: date }) as { at: unknown }).at).toBe(date);
  });

  it('scrubs secret text inside other fields and survives cycles', () => {
    const value: Record<string, unknown> = { message: 'got cfut_abc', count: 3, ok: true };
    value.self = value;
    expect(redactValue(value)).toEqual({ message: 'got [redacted]', count: 3, ok: true, self: '[circular]' });
  });
});
