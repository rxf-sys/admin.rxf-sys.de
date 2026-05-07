import { useEffect, useMemo, useRef, useState } from 'react';
import type { Guest, ServiceStatus } from '../types';
import { Dot, ICONS } from './primitives';

export interface CommandAction {
  id: string;
  title: string;
  hint?: string;
  group: 'Service' | 'Container' | 'Aktion' | 'Theme';
  keywords?: string;
  perform: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  services: ServiceStatus[];
  guests: Guest[];
  onSelectService: (id: string) => void;
  onRestartGuest: (g: Guest) => void;
  onRefresh: () => void;
  onToggleTheme: () => void;
}

/** Simple subsequence fuzzy matcher; returns score (lower = better) or null. */
function fuzzyScore(needle: string, haystack: string): number | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return 0;
  let hi = 0;
  let score = 0;
  let lastMatch = -1;
  for (const c of n) {
    const found = h.indexOf(c, hi);
    if (found === -1) return null;
    if (lastMatch !== -1) score += found - lastMatch - 1;
    lastMatch = found;
    hi = found + 1;
  }
  // bonus for prefix match
  if (h.startsWith(n)) score -= 10;
  return score;
}

export function CommandPalette({
  open,
  onClose,
  services,
  guests,
  onSelectService,
  onRestartGuest,
  onRefresh,
  onToggleTheme,
}: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const allActions = useMemo<CommandAction[]>(() => {
    const out: CommandAction[] = [];
    for (const s of services) {
      out.push({
        id: `svc:${s.id}`,
        title: s.name,
        hint: s.sub,
        group: 'Service',
        keywords: `${s.id} ${s.sub} ${s.desc}`,
        perform: () => {
          onSelectService(s.id);
          onClose();
        },
      });
    }
    for (const g of guests) {
      out.push({
        id: `guest:${g.id}`,
        title: g.name,
        hint: `${g.type} ${g.id}${g.service ? ` · ${g.service}` : ''}`,
        group: 'Container',
        keywords: `${g.id} ${g.service ?? ''} ${g.ip ?? ''}`,
        perform: () => {
          if (g.running) onRestartGuest(g);
          onClose();
        },
      });
    }
    out.push(
      {
        id: 'act:refresh',
        title: 'Daten neu laden',
        hint: 'Alle Polls auslösen',
        group: 'Aktion',
        keywords: 'refresh aktualisieren',
        perform: () => {
          onRefresh();
          onClose();
        },
      },
      {
        id: 'act:theme',
        title: 'Theme wechseln',
        hint: 'Dunkel ↔ Hell',
        group: 'Theme',
        keywords: 'dark light dunkel hell',
        perform: () => {
          onToggleTheme();
          onClose();
        },
      },
    );
    return out;
  }, [services, guests, onSelectService, onRestartGuest, onRefresh, onToggleTheme, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return allActions.slice(0, 30);
    const scored: { a: CommandAction; s: number }[] = [];
    for (const a of allActions) {
      const haystack = `${a.title} ${a.hint ?? ''} ${a.keywords ?? ''}`;
      const s = fuzzyScore(q, haystack);
      if (s !== null) scored.push({ a, s });
    }
    scored.sort((x, y) => x.s - y.s);
    return scored.slice(0, 30).map((x) => x.a);
  }, [query, allActions]);

  // Reset selection when results change.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Focus input when opened, reset state when closed.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // RAF to ensure the input is mounted before focus.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keyboard navigation while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const sel = filtered[active];
        if (sel) sel.perform();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, active, onClose]);

  // Keep the active row scrolled into view (guarded for jsdom).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  if (!open) return null;

  // Group results by category preserving order.
  const grouped: { name: CommandAction['group']; items: { a: CommandAction; idx: number }[] }[] = [];
  filtered.forEach((a, idx) => {
    const last = grouped[grouped.length - 1];
    if (last && last.name === a.group) last.items.push({ a, idx });
    else grouped.push({ name: a.group, items: [{ a, idx }] });
  });

  return (
    <div
      className="cmdk-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Befehlspalette"
    >
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-wrap">
          <span className="cmdk-search-icon" aria-hidden="true">
            {ICONS.search ?? '⌕'}
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Tippen für Service, Container oder Aktion…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Suche"
          />
          <kbd className="cmdk-kbd">ESC</kbd>
        </div>
        {filtered.length === 0 ? (
          <div className="cmdk-empty">Keine Treffer.</div>
        ) : (
          <ul ref={listRef} className="cmdk-list" role="listbox">
            {grouped.map((group) => (
              <li key={group.name} className="cmdk-group">
                <div className="cmdk-group-label">{group.name}</div>
                <ul>
                  {group.items.map(({ a, idx }) => (
                    <li
                      key={a.id}
                      data-idx={idx}
                      className={`cmdk-row ${idx === active ? 'active' : ''}`}
                      role="option"
                      aria-selected={idx === active}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => a.perform()}
                    >
                      {a.group === 'Service' ? (
                        <ServiceMark id={a.id} services={services} />
                      ) : a.group === 'Container' ? (
                        <ContainerMark id={a.id} guests={guests} />
                      ) : (
                        <span className="cmdk-mark mono">⌘</span>
                      )}
                      <span className="cmdk-title">{a.title}</span>
                      {a.hint && <span className="cmdk-hint">{a.hint}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigation</span>
          <span><kbd>↵</kbd> Auswählen</span>
          <span><kbd>ESC</kbd> Schließen</span>
        </div>
      </div>
    </div>
  );
}

function ServiceMark({ id, services }: { id: string; services: ServiceStatus[] }) {
  const svcId = id.replace(/^svc:/, '');
  const svc = services.find((s) => s.id === svcId);
  return svc ? <Dot status={svc.status} /> : <span className="cmdk-mark" />;
}

function ContainerMark({ id, guests }: { id: string; guests: Guest[] }) {
  const guestId = Number(id.replace(/^guest:/, ''));
  const g = guests.find((x) => x.id === guestId);
  return g ? <Dot status={g.status} /> : <span className="cmdk-mark" />;
}
