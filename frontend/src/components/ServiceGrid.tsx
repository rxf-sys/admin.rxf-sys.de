import { useEffect, useRef } from 'react';
import type { ServiceStatus } from '../types';
import { Dot, ICONS, Sparkline } from './primitives';

interface Props {
  services: ServiceStatus[];
  onSelect: (id: string) => void;
  showSpark: boolean;
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

export function ServiceGrid({ services, onSelect, showSpark }: Props) {
  const lastIds = useRef<string>('');
  const sig = services.map((s) => `${s.id}:${s.ms}`).join('|');

  useEffect(() => {
    if (sig === lastIds.current) return;
    lastIds.current = sig;
    services.forEach((s) => pushHistory(s.id, s.ms));
  }, [sig, services]);

  return (
    <section className="dash-section">
      <div className="section-head">
        <h2>
          Services <span className="dim">· {services.length}</span>
        </h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>
            Antwortzeit · live
          </span>
        </div>
      </div>
      <div className="svc-grid">
        {services.map((s) => (
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
  return (
    <button className={`svc-tile status-${svc.status}`} onClick={onClick} type="button">
      <div className="svc-head">
        <span className="svc-icon">{ICONS[svc.icon] ?? ICONS.cloud}</span>
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
      <div className="svc-foot">
        <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
          {Math.round(svc.ms)}
          <span className="dimmer" style={{ fontSize: 10, marginLeft: 2 }}>
            ms
          </span>
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

export function getServiceHistory(id: string): number[] {
  return history[id] ?? [];
}
