import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'auto';
type Density = 'compact' | 'cozy';
type CertWarnDays = 0 | 7 | 14 | 30;

/** Allowed values for the auto-refresh interval, in milliseconds. */
export const REFRESH_INTERVALS_MS: readonly number[] = [5_000, 10_000, 15_000, 30_000, 60_000] as const;

/** Backup polling — fewer changes, longer intervals. */
export const BACKUP_INTERVALS_MS: readonly number[] = [30_000, 60_000, 300_000] as const;

/** Cert polling — change very rarely. */
export const CERT_INTERVALS_MS: readonly number[] = [300_000, 900_000, 3_600_000] as const;

export const CERT_WARN_DAYS: readonly CertWarnDays[] = [0, 7, 14, 30] as const;

export interface UISettings {
  theme: Theme;
  density: Density;
  showSparklines: boolean;
  reduceMotion: boolean;
  /** Base interval for fast polls (services / system / network / tunnel). */
  refreshIntervalMs: number;
  /** Interval for backup-summary polling. */
  pollBackupMs: number;
  /** Interval for cert / DNS polling. */
  pollCertsMs: number;
  notifyStatusChange: boolean;
  notifyBackupFail: boolean;
  /** Warn when any cert expires within N days (0 disables). */
  certWarnDays: CertWarnDays;
}

/** localStorage key for persisted UI settings. Exported so the settings
 * page can preserve it across a "clear local cache" wipe. */
export const STORAGE_KEY = 'rxf-admin-ui';
const DEFAULTS: UISettings = {
  theme: 'auto',
  density: 'compact',
  showSparklines: true,
  reduceMotion: false,
  refreshIntervalMs: 15_000,
  pollBackupMs: 60_000,
  pollCertsMs: 900_000,
  notifyStatusChange: true,
  notifyBackupFail: true,
  certWarnDays: 14,
};

function sanitize(raw: unknown): UISettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  // Pick only known keys — drops legacy fields (e.g. `accent` from older versions)
  // so they don't get re-persisted on the next save.
  const p = raw as Record<string, unknown>;
  const next: UISettings = {
    theme: p.theme === 'dark' || p.theme === 'light' || p.theme === 'auto' ? p.theme : DEFAULTS.theme,
    density: p.density === 'cozy' || p.density === 'compact' ? p.density : DEFAULTS.density,
    showSparklines: typeof p.showSparklines === 'boolean' ? p.showSparklines : DEFAULTS.showSparklines,
    reduceMotion: typeof p.reduceMotion === 'boolean' ? p.reduceMotion : DEFAULTS.reduceMotion,
    refreshIntervalMs:
      typeof p.refreshIntervalMs === 'number' && REFRESH_INTERVALS_MS.includes(p.refreshIntervalMs)
        ? p.refreshIntervalMs
        : DEFAULTS.refreshIntervalMs,
    pollBackupMs:
      typeof p.pollBackupMs === 'number' && BACKUP_INTERVALS_MS.includes(p.pollBackupMs)
        ? p.pollBackupMs
        : DEFAULTS.pollBackupMs,
    pollCertsMs:
      typeof p.pollCertsMs === 'number' && CERT_INTERVALS_MS.includes(p.pollCertsMs)
        ? p.pollCertsMs
        : DEFAULTS.pollCertsMs,
    notifyStatusChange:
      typeof p.notifyStatusChange === 'boolean' ? p.notifyStatusChange : DEFAULTS.notifyStatusChange,
    notifyBackupFail:
      typeof p.notifyBackupFail === 'boolean' ? p.notifyBackupFail : DEFAULTS.notifyBackupFail,
    certWarnDays:
      typeof p.certWarnDays === 'number' && (CERT_WARN_DAYS as readonly number[]).includes(p.certWarnDays)
        ? (p.certWarnDays as CertWarnDays)
        : DEFAULTS.certWarnDays,
  };
  return next;
}

function load(): UISettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export function useUISettings() {
  const [s, setS] = useState<UISettings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // localStorage may be disabled — non-fatal.
    }
  }, [s]);

  // Cross-tab sync: re-load when another tab writes to our key.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue === null) return;
      try {
        setS(sanitize(JSON.parse(e.newValue)));
      } catch {
        // ignore malformed payload
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = <K extends keyof UISettings>(key: K, value: UISettings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  // Merge a (partial, untrusted) settings object — used to hydrate from the
  // server after login. Runs through `sanitize` so unknown keys are dropped.
  const merge = (partial: unknown) =>
    setS((prev) => sanitize({ ...prev, ...(partial as Record<string, unknown>) }));

  return [s, update, merge] as const;
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
