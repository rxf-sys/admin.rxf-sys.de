import { describe, expect, it } from 'vitest';
import { healthResponse } from './health.ts';

describe('healthResponse', () => {
  it('accepts a healthy response', () => {
    expect(healthResponse.parse({ status: 'ok', version: '2.0.0' })).toEqual({
      status: 'ok',
      version: '2.0.0',
    });
  });

  it('rejects any other status', () => {
    expect(healthResponse.safeParse({ status: 'degraded', version: '2.0.0' }).success).toBe(false);
  });

  it('rejects a missing version', () => {
    expect(healthResponse.safeParse({ status: 'ok' }).success).toBe(false);
  });
});
