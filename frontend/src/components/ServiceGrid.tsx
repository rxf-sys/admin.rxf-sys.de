import { useEffect, useRef } from 'react';
import type { ServiceStatus } from '../types';
import { Dot, ICONS, Reach, Sparkline, fmtTimeAgo } from './primitives';

interface Props {
  services: ServiceStatus[];
  onSelect: (id: string) => void;
  showSpark: boolean;
  loading?: boolean;
  isAdmin?: boolean;
  onAddService?: () => void;
  onDeleteService?: (svc: ServiceStatus) => void;
}

const HISTORY_LEN = 60;
const history: Record<string, number[]> = {};

function pushHistory(id: string, ms: number): number[] {
  const cur = history[id] ?? [];
  const next = [...cur, ms].slice(-HISTORY_LEN);
  history[id] = next;
  return next;
}

/** Drop history buckets for services that no longer exist, so the module-level
 * map doesn't accumulate entries for deleted services for the page lifetime. */
function pruneHistory(liveIds: Set<string>): void {
  for (const id of Object.keys(history)) {
    if (!liveIds.has(id)) delete history[id];
  }
}

export function ServiceGrid({
  services,
  onSelect,
  showSpark,
  loading,
  isAdmin,
  onAddService,
  onDeleteService,
}: Props) {
  const lastSig = useRef('');
  const sig = services.map((s) => `${s.id}:${s.ms}`).join('|');
  useEffect(() => {
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    services.forEach((s) => pushHistory(s.id, s.ms));
    pruneHistory(new Set(services.map((s) => s.id)));
  }, [sig, services]);

  const affected = services.filter((s) => s.status !== 'ok').length;
  const isInitialLoad = loading && services.length === 0;

  return (
    <section className="svc-section" aria-labelledby="services-heading">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2 id="services-heading">
          Services <span className="count">· {services.length} · {affected} affected</span>
        </h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>Antwortzeit · letzte 60 min</span>
          {isAdmin && onAddService && (
            <button className="btn sm" type="button" onClick={onAddService}>
              {ICONS.plus} Service hinzufügen
            </button>
          )}
        </div>
      </div>
      <div className="svc-grid" aria-busy={isInitialLoad ? 'true' : undefined}>
        {isInitialLoad
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="svc-tile" aria-hidden="true">
                <div className="skel" style={{ height: 20, width: '60%' }} />
                <div className="skel" style={{ height: 28 }} />
                <div className="skel" style={{ height: 16 }} />
              </div>
            ))
          : services.map((s) =>
              isAdmin && s.custom && onDeleteService ? (
                <div className="svc-tile-wrap" key={s.id}>
                  <ServiceTile svc={s} onClick={() => onSelect(s.id)} showSpark={showSpark} />
                  <button
                    className="svc-tile-del"
                    type="button"
                    title={`${s.name} entfernen`}
                    aria-label={`Service ${s.name} entfernen`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteService(s);
                    }}
                  >
                    {ICONS.trash}
                  </button>
                </div>
              ) : (
                <ServiceTile key={s.id} svc={s} onClick={() => onSelect(s.id)} showSpark={showSpark} />
              ),
            )}
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
  const uptimeClass = uptime == null ? '' : uptime >= 99.9 ? 'ok' : uptime >= 99 ? 'warn' : 'err';
  const msClass = svc.ms > 1000 ? 'err' : svc.ms > 300 ? 'warn' : '';
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
      <div className="svc-spark" aria-hidden="true">
        {showSpark && data.length > 1 && (
          <Sparkline data={data} color={sparkColor} width={260} height={28} area stroke={1.2} />
        )}
      </div>
      <div className="svc-stats">
        <div className="svc-stat">
          <span className="svc-stat-label">Response</span>
          <span className={`svc-stat-value ${msClass}`}>
            {Math.round(svc.ms)}<span className="svc-stat-unit">ms</span>
          </span>
        </div>
        <div className="svc-stat">
          <span className="svc-stat-label">p95 · 24h</span>
          <span className="svc-stat-value dim">
            {svc.p95_ms == null ? '—' : svc.p95_ms}
            {svc.p95_ms != null && <span className="svc-stat-unit">ms</span>}
          </span>
        </div>
        <div className="svc-stat">
          <span className="svc-stat-label">Uptime · 30d</span>
          <span className={`svc-stat-value ${uptimeClass}`}>
            {uptime == null ? '—' : uptime.toFixed(2)}
            {uptime != null && <span className="svc-stat-unit">%</span>}
          </span>
        </div>
      </div>
      <div className="svc-foot">
        <div className="svc-reach">
          {svc.ext_monitored && <Reach ok={svc.ext} label="EXT" />}
          <Reach ok={svc.internal} label="INT" />
        </div>
        <span className="svc-time">
          {svc.last_incident_iso ? `Letzter Vorfall ${fmtTimeAgo(svc.last_incident_iso)}` : 'keine Vorfälle'}
        </span>
      </div>
    </button>
  );
}

export function getServiceHistory(id: string): number[] {
  return history[id] ?? [];
}
