import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSection } from './useSection';

describe('useSection', () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, '', '/');
  });

  afterEach(() => {
    history.replaceState(null, '', '/');
  });

  it('defaults to overview when nothing is stored', () => {
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe('overview');
  });

  it('reads the initial section from the URL hash', () => {
    history.replaceState(null, '', '/#section=backup');
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe('backup');
  });

  it('falls back to localStorage when there is no hash', () => {
    localStorage.setItem('rxf-admin-section', 'cloudflare');
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe('cloudflare');
  });

  it('updates the hash and localStorage when the section changes', () => {
    const { result } = renderHook(() => useSection());
    act(() => result.current[1]('network'));
    expect(result.current[0]).toBe('network');
    expect(window.location.hash).toBe('#section=network');
    expect(localStorage.getItem('rxf-admin-section')).toBe('network');
  });

  it('rejects unknown section values', () => {
    history.replaceState(null, '', '/#section=bogus');
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe('overview');
  });
});
