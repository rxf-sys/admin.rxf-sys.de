import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUISettings } from './useTheme';

describe('useUISettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns defaults when localStorage is empty', () => {
    const { result } = renderHook(() => useUISettings());
    const [s] = result.current;
    expect(s.theme).toBe('auto');
    expect(s.density).toBe('compact');
    expect(s.refreshIntervalMs).toBe(15_000);
    expect(s.pollBackupMs).toBe(60_000);
    expect(s.pollCertsMs).toBe(900_000);
    expect(s.notifyStatusChange).toBe(true);
    expect(s.certWarnDays).toBe(14);
  });

  it('round-trips updates through localStorage', () => {
    const { result, rerender } = renderHook(() => useUISettings());
    act(() => result.current[1]('theme', 'light'));
    act(() => result.current[1]('refreshIntervalMs', 30_000));
    rerender();
    // mounted second hook reads the fresh value from storage
    const { result: second } = renderHook(() => useUISettings());
    expect(second.current[0].theme).toBe('light');
    expect(second.current[0].refreshIntervalMs).toBe(30_000);
  });

  it('rejects stale or unknown values when loading', () => {
    localStorage.setItem(
      'rxf-admin-ui',
      JSON.stringify({
        theme: 'bogus',
        density: 'super-cozy',
        refreshIntervalMs: 999,
        pollBackupMs: 1,
        certWarnDays: 5,
      }),
    );
    const { result } = renderHook(() => useUISettings());
    const [s] = result.current;
    expect(s.theme).toBe('auto');
    expect(s.density).toBe('compact');
    expect(s.refreshIntervalMs).toBe(15_000);
    expect(s.pollBackupMs).toBe(60_000);
    expect(s.certWarnDays).toBe(14);
  });

  it('syncs across tabs via the storage event', () => {
    const { result } = renderHook(() => useUISettings());
    expect(result.current[0].theme).toBe('auto');

    const next = { ...result.current[0], theme: 'dark', density: 'cozy' as const };
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'rxf-admin-ui',
          newValue: JSON.stringify(next),
        }),
      );
    });

    expect(result.current[0].theme).toBe('dark');
    expect(result.current[0].density).toBe('cozy');
  });

  it('drops legacy fields (e.g. accent) silently', () => {
    localStorage.setItem(
      'rxf-admin-ui',
      JSON.stringify({ theme: 'dark', accent: 'cyan', density: 'cozy' }),
    );
    const { result } = renderHook(() => useUISettings());
    const [s] = result.current;
    expect(s.theme).toBe('dark');
    expect(s.density).toBe('cozy');
    expect((s as unknown as { accent?: string }).accent).toBeUndefined();
  });
});
