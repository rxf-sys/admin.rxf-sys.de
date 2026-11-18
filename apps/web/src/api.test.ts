import { healthResponse } from '@rxf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getJson } from './api.ts';

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
    expect(error).toMatchObject({ status: 503 });
  });

  it('throws ApiError when the body breaks the contract', async () => {
    respond(200, { status: 'ok' });
    await expect(getJson('/api/healthz', healthResponse)).rejects.toThrow(/unexpected body/);
  });
});
