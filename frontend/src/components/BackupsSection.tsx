import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  BackupHeatmap,
  BackupSnapshot,
  BackupStorage,
  BackupSummary,
  Guest,
} from '../types';
import { Dot, ICONS, fmtBytes, fmtTimeAgo } from './primitives';

interface Props {
  backups: BackupSummary | null;
  guests: Guest[];
  onVerify?: (snapshot: BackupSnapshot) => void;
  onOpenGuest?: (guest: Guest) => void;
}

const PALETTE = [
  'var(--accent)',
  'var(--info)',
  'var(--ok)',
  'var(--warn)',
  '#9b59ff',
  '#e056a8',
  '#5fd0d7',
  '#c5cad6',
];

export function BackupsSection({ backups, guests, onVerify, onOpenGuest }: Props) {
  const [heatmap, setHeatmap] = useState<BackupHeatmap | null>(null);
  const [storage, setStorage] = useState<BackupStorage | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .backupsHeatmap(30, ctrl.signal)
      .then(setHeatmap)
      .catch(() => {
        /* leave null — render shows skeleton */
      });
    api
      .backupsStorageByGuest(ctrl.signal)
      .then(setStorage)
      .catch(() => {
        /* leave null */
      });
    return () => ctrl.abort();
  }, [backups]);

  const ds = backups?.datastore;
  const usedPct = ds ? Math.min(100, ds.used_pct) : 0;
  const barColor =
    usedPct > 85 ? 'var(--err)' : usedPct > 70 ? 'var(--warn)' : 'var(--accent)';

  return (
    <section className="dash-section">
      <div className="grid-12" style={{ marginBottom: 14 }}>
        <div className="col-5 card">
          <div className="card-h">
            <h3>Datastore</h3>
            <span className="badge">
              {backups?.reachable === false ? 'OFFLINE' : ds?.name ?? '—'}
            </span>
          </div>
          {!ds ? (
            <div className="dimmer mono" style={{ fontSize: 12 }}>
              {backups?.error ?? 'Keine Datastore-Daten — PBS-Token prüfen.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <span
                  className="mono"
                  style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-1)' }}
                >
                  {fmtBytes(ds.used_b)}
                </span>
                <span className="dim mono" style={{ fontSize: 13 }}>
                  / {fmtBytes(ds.total_b)}
                </span>
                <span className="mono dim" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  {usedPct.toFixed(1)}%
                </span>
              </div>
              <div className="bar" style={{ height: 8, marginBottom: 14 }}>
                <div
                  className="bar-fill"
                  style={{ width: `${usedPct}%`, background: barColor }}
                />
              </div>
              <div className="ov-rows">
                <div className="ov-row">
                  <span className="dim">Frei</span>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {fmtBytes(Math.max(0, ds.total_b - ds.used_b))}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">Snapshots heute</span>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {backups.success_today} / {backups.total_today}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">Letzter Erfolg</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {backups.last_success_iso ? fmtTimeAgo(backups.last_success_iso) : '—'}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">Aufbewahrung</span>
                  <span className="dim mono" style={{ fontSize: 11 }}>
                    via PBS Retention-Job
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="col-7 card">
          <div className="card-h">
            <h3>30-Tage Heatmap</h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              {heatmap?.success_pct == null
                ? '—'
                : `success: ${heatmap.success_pct.toFixed(1)}%`}
            </span>
          </div>
          {heatmap === null ? (
            <div className="dimmer" style={{ fontSize: 12 }}>
              Lade…
            </div>
          ) : !heatmap.reachable ? (
            <div className="dimmer" style={{ fontSize: 12, color: 'var(--err)' }}>
              {heatmap.error ?? 'PBS unerreichbar'}
            </div>
          ) : (
            <>
              <div className="day-grid" role="img" aria-label="Backup-Heatmap der letzten 30 Tage">
                {heatmap.cells.map((c) => (
                  <span
                    key={c.day}
                    className={`day-cell day-${c.label}`}
                    title={`${c.day} · ${c.total} Snapshots (ok: ${c.ok}, warn: ${c.warn}, err: ${c.err})`}
                  />
                ))}
              </div>
              <div className="heatmap-legend">
                <LegendCell label="Vollständig" cls="day-ok" />
                <LegendCell label="Teilweise" cls="day-partial" />
                <LegendCell label="Fehler" cls="day-err" />
                <LegendCell label="leer" cls="day-empty" />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid-12" style={{ marginBottom: 14 }}>
        <div className="col-12 card">
          <div className="card-h">
            <h3>Storage by Guest</h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              {storage?.total_b ? `total ${fmtBytes(storage.total_b)}` : '—'}
            </span>
          </div>
          {storage === null ? (
            <div className="dimmer" style={{ fontSize: 12 }}>
              Lade…
            </div>
          ) : storage.items.length === 0 ? (
            <div className="dimmer" style={{ fontSize: 12 }}>
              Keine Snapshots im aktuellen Retention-Fenster.
            </div>
          ) : (
            <StackedStorage storage={storage} />
          )}
          <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
            Hinweis: Summe der Roh-Snapshot-Größen pro Guest. PBS bietet keine
            Dedup-aware-Größe über die Snapshot-API.
          </div>
        </div>
      </div>

      <div className="grid-12">
        <div className="col-12 card">
          <div className="card-h">
            <h3>
              PBS Jobs{' '}
              <span className="dim" style={{ fontWeight: 400, textTransform: 'none' }}>
                · letzte {Math.min(backups?.jobs.length ?? 0, 20)}
              </span>
            </h3>
          </div>
          <JobsTable
            backups={backups}
            guests={guests}
            onVerify={onVerify}
            onOpenGuest={onOpenGuest}
          />
        </div>
      </div>
    </section>
  );
}

function LegendCell({ label, cls }: { label: string; cls: string }) {
  return (
    <span className="heatmap-legend-item">
      <span className={`day-cell ${cls}`} style={{ width: 14, height: 10 }} />
      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</span>
    </span>
  );
}

function StackedStorage({ storage }: { storage: BackupStorage }) {
  const total = storage.total_b || 1;
  return (
    <>
      <div
        className="stacked-bar"
        role="img"
        aria-label={`Speicher pro Guest · total ${fmtBytes(storage.total_b)}`}
      >
        {storage.items.map((it, i) => {
          const pct = (it.size_b / total) * 100;
          if (pct < 0.5) return null;
          return (
            <span
              key={it.target}
              className="stacked-seg"
              style={{
                width: `${pct}%`,
                background: PALETTE[i % PALETTE.length],
              }}
              title={`${it.target} · ${fmtBytes(it.size_b)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="stacked-legend">
        {storage.items.map((it, i) => (
          <div key={it.target} className="stacked-legend-item">
            <span
              className="stacked-swatch"
              style={{ background: PALETTE[i % PALETTE.length] }}
            />
            <span className="mono" style={{ fontSize: 12 }}>
              {it.target}
            </span>
            <span className="dim mono" style={{ fontSize: 11, marginLeft: 'auto' }}>
              {fmtBytes(it.size_b)}{' '}
              <span className="dimmer">· {it.count}× </span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function JobsTable({
  backups,
  guests,
  onVerify,
  onOpenGuest,
}: {
  backups: BackupSummary | null;
  guests: Guest[];
  onVerify?: (snapshot: BackupSnapshot) => void;
  onOpenGuest?: (guest: Guest) => void;
}) {
  if (!backups || backups.jobs.length === 0) {
    return (
      <div className="dimmer mono" style={{ fontSize: 11, padding: 12 }}>
        Keine Backup-Daten verfügbar — PBS-Token prüfen.
      </div>
    );
  }
  const guestByVmid = new Map<number, Guest>();
  guests.forEach((g) => guestByVmid.set(g.id, g));
  return (
    <table className="job-table">
      <thead>
        <tr>
          <th style={{ width: 28 }}></th>
          <th>Target</th>
          <th>Job-ID</th>
          <th style={{ textAlign: 'right' }}>Größe</th>
          <th>Verify</th>
          <th style={{ textAlign: 'right' }}>Wann</th>
          {onVerify && <th style={{ width: 40 }}></th>}
        </tr>
      </thead>
      <tbody>
        {backups.jobs.slice(0, 20).map((j) => {
          const rowCls = j.status === 'err' ? 'attn' : '';
          const vmid = Number(j.backup_id);
          const linkedGuest = Number.isFinite(vmid) ? guestByVmid.get(vmid) : undefined;
          const clickable = !!(onOpenGuest && linkedGuest);
          const onRowClick = clickable
            ? () => onOpenGuest!(linkedGuest!)
            : undefined;
          return (
            <tr
              key={j.id}
              className={rowCls}
              onClick={onRowClick}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              aria-label={
                onRowClick ? `Details für ${linkedGuest!.name} öffnen` : undefined
              }
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick();
                      }
                    }
                  : undefined
              }
            >
              <td>
                <Dot status={j.status} />
              </td>
              <td style={{ fontSize: 13, fontWeight: 500 }}>{j.target}</td>
              <td className="mono dim" style={{ fontSize: 11 }}>
                {j.id.length > 28 ? `${j.id.slice(0, 26)}…` : j.id}
              </td>
              <td className="mono" style={{ textAlign: 'right', fontSize: 12 }}>
                {fmtBytes(j.size_b)}
              </td>
              <td>
                <span
                  className={`verify ${
                    j.verify === 'ok'
                      ? 'ok'
                      : j.verify === 'pending'
                        ? 'warn'
                        : 'idle'
                  }`}
                >
                  {j.verify === 'ok' && ICONS.check}
                  <span style={{ fontSize: 11, marginLeft: 4 }}>
                    {j.verify === 'ok'
                      ? 'verified'
                      : j.verify === 'pending'
                        ? 'pending'
                        : j.verify === 'failed'
                          ? 'failed'
                          : '—'}
                  </span>
                </span>
              </td>
              <td
                className="mono dim"
                style={{ fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' }}
              >
                {fmtTimeAgo(j.when_iso)}
              </td>
              {onVerify && (
                <td
                  style={{ textAlign: 'right' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="btn icon-sm"
                    onClick={() => onVerify(j)}
                    title={
                      j.verify === 'pending'
                        ? 'Verifikation läuft / wurde angefordert'
                        : 'Verify-Job für diesen Snapshot starten'
                    }
                    aria-label={`Verify ${j.target} ${j.backup_time}`}
                    type="button"
                    disabled={j.verify === 'pending'}
                  >
                    {ICONS.check}
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
