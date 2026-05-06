import { useEffect } from 'react';
import type { Guest, ServiceStatus } from '../types';
import { Dot, ICONS, Num, Sparkline, fmtUptime } from './primitives';
import { getServiceHistory } from './ServiceGrid';

interface Props {
  open: boolean;
  svc: ServiceStatus | null;
  guests: Guest[];
  onClose: () => void;
}

function badgeLabel(s: ServiceStatus['status']): string {
  return s === 'ok' ? 'HEALTHY' : s === 'warn' ? 'DEGRADED' : s === 'err' ? 'DOWN' : 'IDLE';
}

export function Drawer({ open, svc, guests, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!svc) return null;

  const data = getServiceHistory(svc.id);
  const sparkColor =
    svc.status === 'warn' ? 'var(--warn)' : svc.status === 'err' ? 'var(--err)' : 'var(--accent)';
  const sorted = [...data].sort((a, b) => a - b);
  const min = data.length ? Math.min(...data) : 0;
  const max = data.length ? Math.max(...data) : 0;
  const avg = data.length ? data.reduce((a, b) => a + b, 0) / data.length : 0;
  const p95 = data.length ? sorted[Math.floor(data.length * 0.95)] ?? max : 0;

  // Heuristic: find the guest most likely backing this service.
  const guest =
    guests.find((g) => (g.service ?? '').toLowerCase().includes(svc.id)) ??
    guests.find((g) => g.name.toLowerCase().includes(svc.id));

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="drawer-h">
          <span className="svc-icon" style={{ width: 36, height: 36 }}>
            {ICONS[svc.icon] ?? ICONS.cloud}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>{svc.name}</h2>
              <Dot status={svc.status} />
              <span className={`badge ${svc.status}`}>{badgeLabel(svc.status)}</span>
            </div>
            <a
              className="mono drawer-link"
              href={`https://${svc.sub}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {svc.sub} {ICONS.external}
            </a>
          </div>
          <button className="btn icon" onClick={onClose} title="Close" type="button">
            {ICONS.close}
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-summary">
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Response
              </span>
              <div>
                <Num value={Math.round(svc.ms)} unit="ms" size="lg" />
              </div>
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Uptime
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {guest ? fmtUptime(guest.uptime_s) : '—'}
              </div>
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                HTTP
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {svc.code_int ?? svc.code_ext ?? '—'}
              </div>
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Reachability
              </span>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <span className={`reach ${svc.ext ? 'ok' : 'off'}`} style={{ padding: '3px 8px' }}>
                  EXT
                </span>
                <span className={`reach ${svc.internal ? 'ok' : 'off'}`} style={{ padding: '3px 8px' }}>
                  INT
                </span>
              </div>
            </div>
          </div>

          <div className="drawer-section">
            <h3>Response time · live</h3>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
              {data.length > 1 ? (
                <>
                  <Sparkline data={data} color={sparkColor} width={520} height={70} />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginTop: 8,
                      fontSize: 11,
                      color: 'var(--text-3)',
                    }}
                  >
                    <span className="mono">min {Math.round(min)}ms</span>
                    <span className="mono">avg {Math.round(avg)}ms</span>
                    <span className="mono">p95 {Math.round(p95)}ms</span>
                    <span className="mono">max {Math.round(max)}ms</span>
                  </div>
                </>
              ) : (
                <div className="dimmer" style={{ fontSize: 12 }}>
                  Sammle Verlauf…
                </div>
              )}
            </div>
          </div>

          {guest && (
            <div className="drawer-section">
              <h3>Container</h3>
              <div className="kv-grid">
                <div>
                  <span className="dim">ID</span>
                  <span className="mono">{guest.id}</span>
                </div>
                <div>
                  <span className="dim">Type</span>
                  <span className={`type-pill type-${guest.type.toLowerCase()}`}>{guest.type}</span>
                </div>
                <div>
                  <span className="dim">IP</span>
                  <span className="mono">{guest.ip ?? '—'}</span>
                </div>
                <div>
                  <span className="dim">Uptime</span>
                  <span className="mono">{fmtUptime(guest.uptime_s)}</span>
                </div>
              </div>
            </div>
          )}

          {svc.note && (
            <div className="drawer-section">
              <h3>Hinweis</h3>
              <div style={{ fontSize: 13, color: 'var(--warn)' }}>{svc.note}</div>
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <a className="btn" href={`https://${svc.sub}`} target="_blank" rel="noopener noreferrer">
            {ICONS.external} Service öffnen
          </a>
        </div>
      </aside>
    </>
  );
}
