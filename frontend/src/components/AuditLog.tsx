import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import { ICONS, fmtTimeAgo } from './primitives';

type Event = Record<string, unknown> & { ts: number; event: string };

function level(event: string): 'ok' | 'warn' | 'err' | 'info' {
  if (event.endsWith('.failure') || event.includes('.error')) return 'err';
  if (event.endsWith('.warn') || event.includes('.degraded')) return 'warn';
  if (event.endsWith('.result') || event.endsWith('.success') || event.endsWith('.recovered')) return 'ok';
  return 'info';
}

/** Audit timestamps are epoch seconds; guard against a missing/bad value. */
function eventIso(ts: unknown): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

interface Props {
  /** Poll interval in ms; 0 pauses (mirrors the global pause switch). */
  pollMs: number;
}

export function AuditLog({ pollMs }: Props) {
  const poll = usePoll((sig) => api.audit(sig), pollMs);
  const events = (poll.data?.events ?? []) as Event[];
  const loading = poll.loading;
  const error = poll.error;

  return (
    <div className="activity-card">
      <div className="card-h">
        <h3>Activity <span className="h3-sub">letzte 24h</span></h3>
        <span className="dimmer mono" style={{ fontSize: 11 }}>
          {error ? 'Fehler beim Laden' : pollMs > 0 ? 'auto' : 'pausiert'}
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
                <span className="a-time">{fmtTimeAgo(eventIso(e.ts))}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
