import { useEffect, useReducer, useRef } from 'react';

type SnapStatus = 'ok' | 'warn' | 'err' | 'idle';

interface Snapshot {
  ts: number;
  status: SnapStatus;
  upCount: number;
  total: number;
}

const STORAGE_KEY = 'rxf-admin-status-history';
const MAX_ENTRIES = 30;

function load(): Snapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Snapshot[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function save(entries: Snapshot[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage may be disabled or full — non-fatal.
  }
}

interface Props {
  /** Captures a new snapshot when this changes (typically lastFetched). */
  pollTs: number;
  servicesUp: number;
  servicesTotal: number;
}

/**
 * Strip of the last 30 dashboard-wide status snapshots, anchored next to the
 * global status pill in the header. Persists to localStorage so a reload
 * doesn't wipe the recent history. Each cell is roughly one poll interval.
 */
export function StatusHistory({ pollTs, servicesUp, servicesTotal }: Props) {
  const historyRef = useRef<Snapshot[]>(load());
  const lastTsRef = useRef<number>(0);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!pollTs || pollTs === lastTsRef.current || servicesTotal === 0) return;
    lastTsRef.current = pollTs;

    const status: SnapStatus = servicesTotal === 0
      ? 'idle'
      : servicesUp === servicesTotal
        ? 'ok'
        : servicesUp >= servicesTotal * 0.5
          ? 'warn'
          : 'err';
    const next: Snapshot[] = [...historyRef.current, { ts: pollTs, status, upCount: servicesUp, total: servicesTotal }];
    while (next.length > MAX_ENTRIES) next.shift();
    historyRef.current = next;
    save(next);
    bump();
  }, [pollTs, servicesUp, servicesTotal]);

  const history = historyRef.current;
  if (history.length === 0) return null;

  return (
    <div
      className="status-history"
      role="img"
      aria-label={`Health-Verlauf: ${history.length} Snapshots, ${history.filter((h) => h.status === 'ok').length} OK`}
      title="Letzte Polls — grün = alle OK, gelb = teilweise degraded, rot = >50 % down"
    >
      {Array.from({ length: MAX_ENTRIES }).map((_, i) => {
        const idx = history.length - MAX_ENTRIES + i;
        const entry = idx >= 0 ? history[idx] : null;
        if (!entry) {
          return <span key={i} className="status-cell empty" aria-hidden="true" />;
        }
        const at = new Date(entry.ts);
        const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`;
        return (
          <span
            key={i}
            className={`status-cell ${entry.status}`}
            title={`${stamp} — ${entry.upCount}/${entry.total} OK`}
          />
        );
      })}
    </div>
  );
}
