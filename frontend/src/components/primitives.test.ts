import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtUptime, fmtTimeAgo } from './primitives';

describe('fmtBytes', () => {
  it('returns "0 B" for falsy input', () => {
    expect(fmtBytes(0)).toBe('0 B');
  });

  it('formats KB/MB/GB with adaptive precision', () => {
    expect(fmtBytes(1024)).toBe('1.00 KB');
    expect(fmtBytes(15 * 1024)).toBe('15.0 KB');
    expect(fmtBytes(1024 * 1024)).toBe('1.00 MB');
    expect(fmtBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(fmtBytes(500 * 1024 * 1024 * 1024)).toBe('500 GB');
  });
});

describe('fmtUptime', () => {
  it('returns dash for zero/negative', () => {
    expect(fmtUptime(0)).toBe('—');
    expect(fmtUptime(-1)).toBe('—');
  });

  it('formats minutes / hours / days', () => {
    expect(fmtUptime(120)).toBe('2m');
    expect(fmtUptime(3700)).toBe('1h 1m');
    expect(fmtUptime(86400 * 2 + 3600 * 5)).toBe('2d 5h');
  });
});

describe('fmtTimeAgo', () => {
  it('returns dash for null', () => {
    expect(fmtTimeAgo(null)).toBe('—');
    expect(fmtTimeAgo(undefined)).toBe('—');
  });

  it('returns "gerade" for very recent', () => {
    const iso = new Date(Date.now() - 5_000).toISOString();
    expect(fmtTimeAgo(iso)).toBe('gerade');
  });

  it('returns minutes for < 1h', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(fmtTimeAgo(iso)).toBe('vor 5 min');
  });
});
