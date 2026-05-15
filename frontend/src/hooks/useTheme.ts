import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'auto';
type Accent = 'peach' | 'indigo' | 'cyan' | 'green';
type Density = 'compact' | 'cozy';

/** Allowed values for the auto-refresh interval, in milliseconds. */
export const REFRESH_INTERVALS_MS: readonly number[] = [0, 5_000, 15_000, 30_000, 60_000] as const;

export interface UISettings {
  theme: Theme;
  accent: Accent;
  density: Density;
  showSparklines: boolean;
  /**
   * Base interval for the fast polls (system / services / tunnel / network).
   * Slower endpoints scale off this value. ``0`` disables auto-refresh
   * outright (same effect as the header pause toggle).
   */
  refreshIntervalMs: number;
}

const STORAGE_KEY = 'rxf-admin-ui';
const DEFAULTS: UISettings = {
  theme: 'auto',
  accent: 'peach',
  density: 'compact',
  showSparklines: true,
  refreshIntervalMs: 15_000,
};

function load(): UISettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = { ...DEFAULTS, ...JSON.parse(raw) } as UISettings;
    // Be defensive against stale values from older versions.
    if (!REFRESH_INTERVALS_MS.includes(parsed.refreshIntervalMs)) {
      parsed.refreshIntervalMs = DEFAULTS.refreshIntervalMs;
    }
    if (parsed.theme !== 'dark' && parsed.theme !== 'light' && parsed.theme !== 'auto') {
      parsed.theme = DEFAULTS.theme;
    }
    return parsed;
  } catch {
    return DEFAULTS;
  }
}

export function useUISettings() {
  const [s, setS] = useState<UISettings>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }, [s]);

  const update = <K extends keyof UISettings>(key: K, value: UISettings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  return [s, update] as const;
}

/**
 * Resolves a theme setting (which may be ``'auto'``) to a concrete light/dark
 * value, and re-renders when the OS preference flips while ``'auto'`` is
 * selected.
 */
export function useResolvedTheme(theme: Theme): 'dark' | 'light' {
  const getMatch = (): 'dark' | 'light' => {
    if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    if (mq.addEventListener) {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  if (theme === 'auto') return systemTheme;
  return theme;
}
