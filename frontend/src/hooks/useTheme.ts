import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';
type Accent = 'peach' | 'indigo' | 'cyan' | 'green';
type Density = 'compact' | 'cozy';

export interface UISettings {
  theme: Theme;
  accent: Accent;
  density: Density;
  showSparklines: boolean;
}

const STORAGE_KEY = 'rxf-admin-ui';
const DEFAULTS: UISettings = {
  theme: 'dark',
  accent: 'peach',
  density: 'compact',
  showSparklines: true,
};

function load(): UISettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
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
