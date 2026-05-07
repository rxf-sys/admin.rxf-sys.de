import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { fmtTimeAgo } from './primitives';

type Event = Record<string, unknown> & { ts: number; event: string };

export function AuditLog() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const lastFetchRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await api.audit();
        if (cancelled) return;
        setEvents(r.events as Event[]);
        setError(false);
        lastFetchRef.current = Date.now();
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="dash-section" aria-labelledby="audit-heading">
      <div className="section-head">
        <h2 id="audit-heading">
          Audit-Log <span className="dim">· letzte {events.length}</span>
        </h2>
        <span className="dimmer mono" style={{ fontSize: 11 }}>
          {error ? 'Fehler beim Laden' : 'auto · 30s'}
        </span>
      </div>
      <div className="card flat" style={{ padding: 0, overflow: 'hidden' }}>
        {loading && events.length === 0 ? (
          <div className="dimmer mono" style={{ fontSize: 12, padding: 14 }}>
            Lade…
          </div>
        ) : events.length === 0 ? (
          <div className="dimmer mono" style={{ fontSize: 12, padding: 14 }}>
            Noch keine Audit-Events seit Backend-Start.
          </div>
        ) : (
          <ul className="audit-list">
            {events.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="audit-row">
                <span className={`audit-tag ${classify(e.event)}`}>{e.event}</span>
                <span className="audit-fields mono">{formatFields(e)}</span>
                <span className="dim mono audit-time">
                  {fmtTimeAgo(new Date((e.ts as number) * 1000).toISOString())}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function classify(event: string): string {
  if (event.endsWith('.result')) return 'result';
  if (event.startsWith('guest.')) return 'guest';
  return 'other';
}

function formatFields(e: Event): string {
  const omit = new Set(['ts', 'event']);
  return Object.entries(e)
    .filter(([k]) => !omit.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}
