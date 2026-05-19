import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ICONS, fmtTimeAgo } from './primitives';

type Event = Record<string, unknown> & { ts: number; event: string };

function level(event: string): 'ok' | 'warn' | 'err' | 'info' {
  if (event.endsWith('.failure') || event.includes('.error')) return 'err';
  if (event.endsWith('.warn') || event.includes('.degraded')) return 'warn';
  if (event.endsWith('.result') || event.endsWith('.success') || event.endsWith('.recovered')) return 'ok';
  return 'info';
}

function describe(e: Event): { strong?: string; tag?: string; text: string } {
  const target = (e.target as string | undefined) ?? (e.guest as string | undefined) ?? (e.service as string | undefined);
  const action = e.event.replace(/^(guest|service|backup|cert|cloudflare|system)\./, '');
  const status = e.status as string | undefined;
  const tag = e.event;
  if (target) {
    return { strong: target, tag, text: status ? `${action} → ${status}` : action };
  }
  return { tag, text: action };
}

export function AuditLog() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await api.audit();
        if (cancelled) return;
        setEvents(r.events as Event[]);
        setError(false);
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
    <div className="activity-card">
      <div className="card-h">
        <h3>Activity <span className="h3-sub">letzte 24h</span></h3>
        <span className="dimmer mono" style={{ fontSize: 11 }}>
          {error ? 'Fehler beim Laden' : 'auto · 30s'}
        </span>
      </div>
      <div className="activity-list">
        {loading && events.length === 0 ? (
          <div className="dim" style={{ fontSize: 12, padding: 14 }}>Lade…</div>
        ) : events.length === 0 ? (
          <div className="dim" style={{ fontSize: 12, padding: 14 }}>Noch keine Events.</div>
        ) : (
          events.slice(0, 12).map((e, i) => {
            const lvl = level(e.event);
            const d = describe(e);
            return (
              <div key={`${e.ts}-${i}`} className="activity-row">
                <span className={`a-icon ${lvl}`} aria-hidden="true">
                  {lvl === 'ok' ? ICONS.check : lvl === 'err' ? ICONS.x : lvl === 'warn' ? ICONS.warn : ICONS.info}
                </span>
                <span className="a-text" title={JSON.stringify(e)}>
                  {d.strong && <strong>{d.strong} </strong>}
                  {d.tag && <span className="a-tag">{d.tag}</span>}
                  {d.text}
                </span>
                <span className="a-time">{fmtTimeAgo(new Date((e.ts as number) * 1000).toISOString())}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
