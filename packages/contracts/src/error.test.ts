import { describe, expect, it } from 'vitest';
import { errorResponse } from './error.ts';

describe('errorResponse', () => {
  it('accepts code and message with optional details', () => {
    expect(errorResponse.safeParse({ error: { code: 'NOT_FOUND', message: 'Route not found' } }).success).toBe(true);
    expect(
      errorResponse.safeParse({ error: { code: 'VALIDATION_FAILED', message: 'x', details: { issues: [] } } }).success,
    ).toBe(true);
  });

  it('rejects a body without a code', () => {
    expect(errorResponse.safeParse({ error: { message: 'x' } }).success).toBe(false);
  });
});
