import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  BackupHeatmap,
  BackupHeatmapCell,
  BackupSnapshot,
  BackupStorage,
  BackupSummary,
  Guest,
} from '../types';
import { Dot, ICONS, StackedBar, fmtBytes, fmtTimeAgo, type StackedSegment } from './primitives';

interface Props {
  backups: BackupSummary | null;
  guests: Guest[];
  onVerify?: (snapshot: BackupSnapshot) => void;
  onOpenGuest?: (guest: Guest) => void;
}

const PALETTE = ['#4fe9a4', '#4f9eff', '#ffb17a', '#7ab6ff', '#00d97e', '#5a608a', '#e056a8', '#5fd0d7'];

// Maps the backend's heatmap label onto the design's day-cell variant class.
const CELL_CLASS: Record<BackupHeatmapCell['label'], string> = {
  ok: 'ok',
  partial: 'half',
  err: 'fail',
  empty: '',
};

export function BackupsSection({ backups, guests, onVerify, onOpenGuest }: Props) {
  const [heatmap, setHeatmap] = useState<BackupHeatmap | null>(null);
  const [storage, setStorage] = useState<BackupStorage | null>(null);
  const [heatmapError, setHeatmapError] = useState(false);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setHeatmapError(false);
    setStorageError(false);
    api
      .backupsHeatmap(30, ctrl.signal)
      .then(setHeatmap)
      .catch(() => {
        if (!ctrl.signal.aborted) setHeatmapError(true);
      });
    api
      .backupsStorageByGuest(ctrl.signal)
      .then(setStorage)
      .catch(() => {
        if (!ctrl.signal.aborted) setStorageError(true);
      });
    return () => ctrl.abort();
  }, [backups]);

  const ds = backups?.datastore;
  const usedPct = ds ? Math.min(100, ds.used_pct) : 0;
  const barColor = usedPct > 85 ? 'var(--err)' : usedPct > 70 ? 'var(--warn)' : 'var(--ok)';

  return (
    <section className="backup-section">
      <div className="grid-12" style={{ marginBottom: 16 }}>
        {/* Datastore */}
        <div className="card col-5">
          <div className="card-h">
            <h3>Datastore {ds && <span className="h3-sub">· {ds.name}</span>}</h3>
            <span className={`badge ${backups?.reachable === false ? 'err' : 'ok'}`}>
              <Dot status={backups?.reachable === false ? 'err' : 'ok'} />
              {backups?.reachable === false ? 'OFFLINE' : 'REACHABLE'}
            </span>
          </div>
          {!ds ? (
            <div className="dim" style={{ fontSize: 12 }}>
              {backups?.error ?? 'Keine Datastore-Daten — PBS-Token prüfen.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 12 }}>
                <span className="mono" style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.5px', color: 'var(--text-1)' }}>
                  {fmtBytes(ds.used_b)}
                  <span style={{ fontSize: 14, color: 'var(--text-3)' }}> / {fmtBytes(ds.total_b)}</span>
                </span>
                <span className="mono" style={{ fontSize: 18, color: barColor, marginBottom: 4 }}>
                  {usedPct.toFixed(1)}%
                </span>
              </div>
              <div className="bar thick">
                <div className="bar-fill" style={{ width: `${usedPct}%`, background: barColor }} />
              </div>
              <div className="kv-stack" style={{ marginTop: 14 }}>
                <div className="kv-row">
                  <span className="kv-k">Frei</span>
                  <span className="kv-v mono">{fmtBytes(Math.max(0, ds.total_b - ds.used_b))}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-k">Snapshots heute</span>
                  <span className="kv-v mono">{backups.success_today} / {backups.total_today}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-k">Letzter Erfolg</span>
                  <span className="kv-v mono">{backups.last_success_iso ? fmtTimeAgo(backups.last_success_iso) : '—'}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-k">Aufbewahrung</span>
                  <span className="kv-v mono" style={{ fontSize: 11 }}>via PBS Retention-Job</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 30-day heatmap */}
        <div className="card col-7">
          <div className="card-h">
            <h3>30 Tage Trend <span className="h3-sub">· Snapshots pro Tag</span></h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              {heatmap?.success_pct == null ? '—' : `success: ${heatmap.success_pct.toFixed(1)}%`}
            </span>
          </div>
          {heatmapError ? (
            <div className="dim" style={{ fontSize: 12, color: 'var(--err)', padding: '20px 0' }}>
              Heatmap konnte nicht geladen werden.
            </div>
          ) : heatmap === null ? (
            <div className="dim" style={{ fontSize: 12, padding: '20px 0' }}>Lade…</div>
          ) : !heatmap.reachable ? (
            <div className="dim" style={{ fontSize: 12, color: 'var(--err)', padding: '20px 0' }}>
              {heatmap.error ?? 'PBS unerreichbar'}
            </div>
          ) : (
            <>
              <div className="day-grid" role="img" aria-label="Backup-Heatmap der letzten 30 Tage">
                {heatmap.cells.map((c) => (
                  <span
                    key={c.day}
                    className={`day-cell ${CELL_CLASS[c.label]}`}
                    title={`${c.day} · ${c.total} Snapshots (ok: ${c.ok}, warn: ${c.warn}, err: ${c.err})`}
                  >
                    {c.total > 0 ? c.total : ''}
                  </span>
                ))}
              </div>
              <div className="day-legend">
                <span><span className="swatch-inline day-cell ok" /> Vollständig</span>
                <span><span className="swatch-inline day-cell half" /> Teilweise</span>
                <span><span className="swatch-inline day-cell fail" /> Fehler</span>
                <span><span className="swatch-inline day-cell" /> leer</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Storage by guest */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12">
          <div className="card-h">
            <h3>Storage by Guest <span className="h3-sub">· Roh-Snapshot-Größe</span></h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              {storage?.total_b ? `total ${fmtBytes(storage.total_b)}` : '—'}
            </span>
          </div>
          {storageError ? (
            <div className="dim" style={{ fontSize: 12, color: 'var(--err)' }}>
              Storage-Aufschlüsselung konnte nicht geladen werden.
            </div>
          ) : storage === null ? (
            <div className="dim" style={{ fontSize: 12 }}>Lade…</div>
          ) : storage.items.length === 0 ? (
            <div className="dim" style={{ fontSize: 12 }}>Keine Snapshots im aktuellen Retention-Fenster.</div>
          ) : (
            <StackedStorage storage={storage} />
          )}
        </div>
      </div>

      {/* PBS jobs */}
      <div className="grid-12">
        <div className="card col-12" style={{ padding: 0 }}>
          <div style={{ padding: '18px 20px' }}>
            <div className="card-h" style={{ marginBottom: 0 }}>
              <h3>PBS Jobs <span className="h3-sub">· {backups?.jobs.length ?? 0} Einträge</span></h3>
            </div>
          </div>
          <JobsTable backups={backups} guests={guests} onVerify={onVerify} onOpenGuest={onOpenGuest} />
        </div>
      </div>
    </section>
  );
}

function StackedStorage({ storage }: { storage: BackupStorage }) {
  const segments: StackedSegment[] = storage.items.map((it, i) => ({
    name: it.target,
    gb: it.size_b / 1024 ** 3,
    color: PALETTE[i % PALETTE.length],
  }));
  return (
    <>
      <StackedBar segments={segments} />
      <div className="stacked-legend" style={{ marginTop: 12 }}>
        {storage.items.map((it, i) => (
          <span key={it.target} className="item">
            <span className="swatch-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span>{it.target}</span>
            <span className="item-val">{fmtBytes(it.size_b)}</span>
            <span className="dimmer">· {it.count}×</span>
          </span>
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
      <div className="dim mono" style={{ fontSize: 11, padding: 16 }}>
        Keine Backup-Daten verfügbar — PBS-Token prüfen.
      </div>
    );
  }
  const guestByVmid = new Map<number, Guest>();
  guests.forEach((g) => guestByVmid.set(g.id, g));
  return (
    <JobsTableBody
      jobs={backups.jobs}
      guestByVmid={guestByVmid}
      onVerify={onVerify}
      onOpenGuest={onOpenGuest}
    />
  );
}

const JOBS_PAGE_SIZE = 10;

/** PBS jobs list with client-side pagination — pages of 10 above 10 entries. */
function JobsTableBody({
  jobs,
  guestByVmid,
  onVerify,
  onOpenGuest,
}: {
  jobs: BackupSnapshot[];
  guestByVmid: Map<number, Guest>;
  onVerify?: (snapshot: BackupSnapshot) => void;
  onOpenGuest?: (guest: Guest) => void;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageJobs = jobs.slice(safePage * JOBS_PAGE_SIZE, safePage * JOBS_PAGE_SIZE + JOBS_PAGE_SIZE);
  return (
    <>
    <table className="job-table">
      <thead>
        <tr>
          <th style={{ width: 28 }}></th>
          <th>Target</th>
          <th>Job-ID</th>
          <th style={{ textAlign: 'right' }}>Größe</th>
          <th>Verify</th>
          <th style={{ textAlign: 'right' }}>Wann</th>
          {onVerify && <th style={{ width: 44 }}></th>}
        </tr>
      </thead>
      <tbody>
        {pageJobs.map((j) => {
          const rowCls = j.status === 'err' ? 'attn' : '';
          const vmid = Number(j.backup_id);
          const linkedGuest = Number.isFinite(vmid) ? guestByVmid.get(vmid) : undefined;
          const clickable = !!(onOpenGuest && linkedGuest);
          const onRowClick = clickable ? () => onOpenGuest!(linkedGuest!) : undefined;
          return (
            <tr
              key={j.id}
              className={rowCls}
              onClick={onRowClick}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              aria-label={onRowClick ? `Details für ${linkedGuest!.name} öffnen` : undefined}
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
              <td><Dot status={j.status} /></td>
              <td style={{ fontWeight: 600 }}>
                {j.target}
                {j.note && <div style={{ fontSize: 11, color: 'var(--err)' }}>{j.note}</div>}
              </td>
              <td className="mono dimmer" style={{ fontSize: 10.5 }}>
                {j.id.split('/').slice(-1)[0]}
              </td>
              <td className="mono" style={{ textAlign: 'right' }}>{j.size_b > 0 ? fmtBytes(j.size_b) : '—'}</td>
              <td>
                <span className={`verify ${j.verify === 'ok' ? 'ok' : j.verify === 'pending' ? 'warn' : ''}`}>
                  {j.verify === 'ok' ? ICONS.check : <span className="dimmer">—</span>}
                  <span style={{ marginLeft: 4 }}>
                    {j.verify === 'ok' ? 'verified' : j.verify === 'pending' ? 'pending' : j.verify === 'failed' ? 'failed' : '—'}
                  </span>
                </span>
              </td>
              <td className="mono dim" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {fmtTimeAgo(j.when_iso)}
              </td>
              {onVerify && (
                <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn icon"
                    style={{ width: 26, height: 26 }}
                    onClick={() => onVerify(j)}
                    title={j.verify === 'pending' ? 'Verifikation läuft' : 'Verify-Job starten'}
                    aria-label={`Verify ${j.target}`}
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
    {jobs.length > JOBS_PAGE_SIZE && (
      <div className="pager">
        <button
          className="btn sm"
          type="button"
          disabled={safePage === 0}
          onClick={() => setPage(safePage - 1)}
        >
          ‹ Zurück
        </button>
        <span className="mono">
          Seite {safePage + 1} / {pageCount}
        </span>
        <button
          className="btn sm"
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => setPage(safePage + 1)}
        >
          Weiter ›
        </button>
      </div>
    )}
    </>
  );
}
