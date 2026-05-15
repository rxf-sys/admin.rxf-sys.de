import { useEffect, useState } from 'react';

export type Section = 'overview' | 'server' | 'network' | 'backup' | 'cloudflare';

const STORAGE_KEY = 'rxf-admin-section';
const VALID: readonly Section[] = ['overview', 'server', 'network', 'backup', 'cloudflare'];

function parse(raw: string | null | undefined): Section | null {
  if (!raw) return null;
  return (VALID as readonly string[]).includes(raw) ? (raw as Section) : null;
}

function readFromHash(): Section | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/section=([a-z]+)/i);
  return parse(match?.[1]);
}

function readInitial(): Section {
  return (
    readFromHash() ??
    parse(typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null) ??
    'overview'
  );
}

/**
 * Dashboard section navigation, persisted in both the URL hash (for deep
 * linking and back/forward) and localStorage (so a fresh load without a hash
 * still lands on the last-used tab).
 */
export function useSection() {
  const [section, setSection] = useState<Section>(readInitial);

  // Keep localStorage and URL in sync whenever the user clicks a tab.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, section);
    } catch {
      // localStorage may be disabled — non-fatal.
    }
    const hash = `#section=${section}`;
    if (window.location.hash !== hash) {
      // Use replaceState so the back button doesn't fill up with every click.
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
  }, [section]);

  // Respect external hash changes (manual edit, back/forward).
  useEffect(() => {
    const onHashChange = () => {
      const next = readFromHash();
      if (next && next !== section) setSection(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [section]);

  return [section, setSection] as const;
}
