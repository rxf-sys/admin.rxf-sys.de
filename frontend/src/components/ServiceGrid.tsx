import { useEffect, useRef } from 'react';
import type { ServiceStatus } from '../types';
import { Dot, ICONS, Sparkline } from './primitives';

interface Props {
  services: ServiceStatus[];
  onSelect: (id: string) => void;
  showSpark: boolean;
  loading?: boolean;
}

const HISTORY_LEN = 60;

// Tracks per-service rolling response-time history client-side, since the
// backend exposes only the current measurement. Updated each refresh.
const history: Record<string, number[]> = {};

function pushHistory(id: string, ms: number): number[] {
  const cur = history[id] ?? [];
  const next = [...cur, ms].slice(-HISTORY_LEN);
  history[id] = next;
  return next;
}

export function ServiceGrid({ services, onSelect, showSpark, loading }: Props) {
  const lastIds = useRef<string>('');
  const sig = services.map((s) => `${s.id}:${s.ms}`).join('|');

  useEffect(() => {
    if (sig === lastIds.current) return;
    lastIds.current = sig;
    services.forEach((s) => pushHistory(s.id, s.ms));
  }, [sig, services]);

  const isInitialLoad = loading && services.length === 0;

  return (
    <section className="dash-section" aria-labelledby="services-heading">
      <div className="section-head">
        <h2 id="services-heading">
          Services <span className="dim">· {services.length}</span>
        </h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>
            Antwortzeit · live
          </span>
        </div>
      </div>
      <div className="svc-grid" aria-busy={isInitialLoad ? 'true' : undefined}>
        {isInitialLoad
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="svc-tile skeleton-tile" aria-hidden="true">
                <div className="skeleton skeleton-h" />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line" />
              </div>
            ))
          : services.map((s) => (
              <ServiceTile key={s.id} svc={s} onClick={() => onSelect(s.id)} showSpark={showSpark} />
            ))}
      </div>
    </section>
  );
}

interface TileProps {
  svc: ServiceStatus;
  onClick: () => void;
  showSpark: boolean;
}

export function ServiceTile({ svc, onClick, showSpark }: TileProps) {
  const sparkColor =
    svc.status === 'warn' ? 'var(--warn)' : svc.status === 'err' ? 'var(--err)' : 'var(--accent)';
  const data = history[svc.id] ?? [svc.ms];
  const statusWord =
    svc.status === 'ok' ? 'erreichbar' : svc.status === 'warn' ? 'eingeschränkt' : svc.status === 'err' ? 'nicht erreichbar' : 'inaktiv';
  const uptime = svc.uptime_pct;
  const uptimeClass =
    uptime == null ? '' : uptime >= 99.5 ? 'ok' : uptime >= 95 ? 'warn' : 'err';
  return (
    <button
      className={`svc-tile status-${svc.status}`}
      onClick={onClick}
      type="button"
      aria-label={`${svc.name}, ${statusWord}, ${Math.round(svc.ms)} Millisekunden`}
    >
      <div className="svc-head">
        <span className="svc-icon" aria-hidden="true">{ICONS[svc.icon] ?? ICONS.cloud}</span>
        <div className="svc-name">
          <span className="svc-title">{svc.name}</span>
          <span className="svc-sub mono">{svc.sub}</span>
        </div>
        <Dot status={svc.status} />
      </div>
      <div className="svc-mid">
        {showSpark && data.length > 1 && (
          <Sparkline data={data} color={sparkColor} width={140} height={26} />
        )}
      </div>
      <div className="svc-stats" aria-hidden="true">
        <div className="svc-stat">
          <span className="svc-stat-label">Response</span>
          <span className="svc-stat-value mono">
            {Math.round(svc.ms)}
            <span className="svc-stat-unit">ms</span>
          </span>
        </div>
        <div className="svc-stat">
          <span className="svc-stat-label">p95 · 24h</span>
          <span className="svc-stat-value mono">
            {svc.p95_ms == null ? '—' : `${svc.p95_ms}`}
            <span className="svc-stat-unit">{svc.p95_ms == null ? '' : 'ms'}</span>
          </span>
        </div>
        <div className="svc-stat">
          <span className="svc-stat-label">Uptime · 30d</span>
          <span className={`svc-stat-value mono ${uptimeClass}`}>
            {uptime == null ? '—' : `${uptime.toFixed(2)}`}
            <span className="svc-stat-unit">{uptime == null ? '' : '%'}</span>
          </span>
        </div>
      </div>
      <div className="svc-foot">
        <span className="dimmer mono" style={{ fontSize: 10 }}>
          {svc.last_incident_iso
            ? `Letzter Vorfall ${fmtIncidentAgo(svc.last_incident_iso)}`
            : 'Keine Vorfälle aufgezeichnet'}
        </span>
        <div className="svc-reach">
          <span
            className={`reach ${svc.ext ? 'ok' : 'off'}`}
            title={`Extern ${svc.ext ? 'erreichbar' : 'nicht erreichbar'}`}
          >
            EXT
          </span>
          <span
            className={`reach ${svc.internal ? 'ok' : 'off'}`}
            title={`Intern ${svc.internal ? 'erreichbar' : 'nicht erreichbar'}`}
          >
            INT
          </span>
        </div>
      </div>
    </button>
  );
}

function fmtIncidentAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return iso;
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'gerade';
  if (diff < 3600) return `vor ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `vor ${Math.round(diff / 3600)} h`;
  return `vor ${Math.round(diff / 86400)} d`;
}

export function getServiceHistory(id: string): number[] {
  return history[id] ?? [];
}
