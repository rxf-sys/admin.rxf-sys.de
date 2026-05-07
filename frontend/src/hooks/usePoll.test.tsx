import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePoll } from './usePoll';

describe('usePoll', () => {
  it('loads data and exposes lastFetched', async () => {
    const loader = vi.fn(async () => ({ value: 42 }));
    const { result } = renderHook(() => usePoll(loader, 0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetched).toBeGreaterThan(0);
  });

  it('captures errors without clobbering data', async () => {
    const err = new Error('boom');
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { value: 1 };
      throw err;
    });

    const { result } = renderHook(() => usePoll(loader, 0));
    await waitFor(() => expect(result.current.data).toEqual({ value: 1 }));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBe(err));

    // Last successful data should still be available alongside the error.
    expect(result.current.data).toEqual({ value: 1 });
  });
});
