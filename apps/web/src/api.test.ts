import { healthResponse } from '@rxf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getJson, okResponse, sendJson, setCsrfToken } from './api.ts';
import { describeAgent } from './app/agent.ts';
import { errorText } from './ui/errors.ts';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('getJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the validated body', async () => {
    respond(200, { status: 'ok', version: '2.0.0' });
    await expect(getJson('/api/healthz', healthResponse)).resolves.toEqual({ status: 'ok', version: '2.0.0' });
  });

  it('throws ApiError with the status on a non-2xx answer', async () => {
    respond(503, { error: { code: 'UNAVAILABLE', message: 'down' } });
    const error = await getJson('/api/healthz', healthResponse).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: 'UNAVAILABLE' });
  });

  it('falls back to HTTP_<status> without an error envelope', async () => {
    respond(502, 'bad gateway');
    await expect(getJson('/api/healthz', healthResponse)).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('throws ApiError when the body breaks the contract', async () => {
    respond(200, { status: 'ok' });
    await expect(getJson('/api/healthz', healthResponse)).rejects.toThrow(/unexpected body/);
  });
});

describe('sendJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('sends JSON with the CSRF token and validates the answer', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('token-1');
    await expect(sendJson('POST', '/api/x', okResponse, { a: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': 'token-1', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('sends no body and no token when there is none', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await sendJson('DELETE', '/api/x', okResponse);
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { method: 'DELETE', headers: { accept: 'application/json' } });
  });
});

describe('errorText', () => {
  it.each([
    [new ApiError('x', 401, 'INVALID_CODE'), 'Der Code stimmt nicht oder wurde schon benutzt.'],
    [
      new ApiError('x', 400, 'WEAK_PASSWORD', { problem: 'too_short' }),
      'Das Passwort ist zu kurz: mindestens 12 Zeichen.',
    ],
    [
      new ApiError('x', 400, 'WEAK_PASSWORD', { problem: 'odd' }),
      'Das hat nicht geklappt. Bitte versuche es noch einmal.',
    ],
    [new ApiError('x', 500, 'INTERNAL'), 'Das hat nicht geklappt. Bitte versuche es noch einmal.'],
    [new Error('boom'), 'Das hat nicht geklappt. Bitte versuche es noch einmal.'],
  ])('%s', (error, text) => {
    expect(errorText(error)).toBe(text);
  });
});

describe('describeAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36 Edg/150.0',
      'Edge · Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Safari/604.1',
      'Safari · iOS',
    ],
    ['Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['curl/8.0', 'curl/8.0'],
  ])('%s', (agent, text) => {
    expect(describeAgent(agent)).toBe(text);
  });
});
