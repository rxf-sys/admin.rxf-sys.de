import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  BackupHeatmap,
  BackupSchedule,
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

const GUEST_PALETTE = ['#4fe9a4', '#4f9eff', '#ffb17a', '#7ab6ff', '#00d97e', '#5a608a', '#e056a8', '#5fd0d7'];

export function BackupsSection({ backups, guests, onVerify, onOpenGuest }: Props) {
  const [heatmap, setHeatmap] = useState<BackupHeatmap | null>(null);
  const [storage, setStorage] = useState<BackupStorage | null>(null);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [heatmapError, setHeatmapError] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [scheduleError, setScheduleError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setHeatmapError(false);
    setStorageError(false);
    setScheduleError(false);
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
    api
      .backupsSchedule(ctrl.signal)
      .then(setSchedule)
      .catch(() => {
        if (!ctrl.signal.aborted) setScheduleError(true);
      });
    return () => ctrl.abort();
  }, [backups]);

  return (
    <section className="backup-section">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2>Backup</h2>
        <span className="dimmer mono" style={{ fontSize: 11 }}>
          {backups?.datastore ? `${backups.datastore.name} @ PBS` : 'Proxmox Backup Server'}
        </span>
      </div>

      {/* Top row: Datastore donut + Storage-by-guest + Schedule */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <DatastoreCard backups={backups} />
        <StorageByGuestCard storage={storage} errored={storageError} />
        <ScheduleCard schedule={schedule} errored={scheduleError} />
      </div>

      {/* 30-day trend (stacked bars + GB/day line) */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <BackupTrendCard
          heatmap={heatmap}
          loading={heatmap === null && !heatmapError}
          errored={heatmapError}
        />
      </div>

      {/* PBS jobs */}
      <div className="grid-12">
        <div className="card col-12" style={{ padding: 0 }}>
          <div style={{ padding: '18px 20px' }}>
            <div className="card-h" style={{ marginBottom: 0 }}>
              <h3>Jobs heute <span className="h3-sub">· {backups?.jobs.length ?? 0} Einträge</span></h3>
            </div>
          </div>
          <div className="card-scroll-x">
            <JobsTable backups={backups} guests={guests} onVerify={onVerify} onOpenGuest={onOpenGuest} />
          </div>
        </div>
      </div>
    </section>
  );
}

function DatastoreCard({ backups }: { backups: BackupSummary | null }) {
  const ds = backups?.datastore;
  const pct = ds ? Math.min(100, ds.used_pct) : 0;
  const ringColor = pct > 85 ? 'var(--err)' : pct > 70 ? 'var(--warn)' : 'var(--ok)';
  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>Datastore {ds && <span className="h3-sub">· {ds.name}</span>}</h3>
        <span className={`badge ${backups?.reachable === false ? 'err' : 'ok'}`}>
          <Dot status={backups?.reachable === false ? 'err' : 'ok'} />
          {backups?.success_today != null && backups?.total_today
            ? `${backups.success_today}/${backups.total_today} HEUTE`
            : backups?.reachable === false
              ? 'OFFLINE'
              : 'REACHABLE'}
        </span>
      </div>
      {!ds ? (
        <div className="dim" style={{ fontSize: 12 }}>
          {backups?.error ?? 'Keine Datastore-Daten — PBS-Token prüfen.'}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <Donut pct={pct} color={ringColor} label={`${pct.toFixed(0)}%`} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-4)', textTransform: 'uppercase' }}>
              Belegt
            </span>
            <span className="mono" style={{ fontSize: 14, color: 'var(--text-3)' }}>
              {fmtBytes(ds.used_b)}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-4)', textTransform: 'uppercase', marginTop: 6 }}>
              Frei
            </span>
            <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-1)' }}>
              {fmtBytes(Math.max(0, ds.total_b - ds.used_b))}
            </span>
            <span className="dimmer mono" style={{ fontSize: 10.5, marginTop: 4 }}>
              total {fmtBytes(ds.total_b)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function StorageByGuestCard({
  storage,
  errored,
}: {
  storage: BackupStorage | null;
  errored: boolean;
}) {
  const items = storage?.items ?? [];
  const maxSize = items.reduce((acc, it) => Math.max(acc, it.size_b), 0) || 1;
  // Cap list height: show top 5 individual guests, fold the rest into "andere".
  const TOP_N = 5;
  const top = items.slice(0, TOP_N);
  const rest = items.slice(TOP_N);
  const restSize = rest.reduce((s, it) => s + it.size_b, 0);
  const display = rest.length > 0
    ? [...top, { target: `andere (${rest.length})`, size_b: restSize, _bucket: true } as { target: string; size_b: number; _bucket?: boolean }]
    : top;

  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>Grösse nach Gast</h3>
        <span className="dimmer mono" style={{ fontSize: 11 }}>
          {storage?.total_b ? fmtBytes(storage.total_b) : '—'}
        </span>
      </div>
      {errored ? (
        <div className="dim" style={{ fontSize: 12, color: 'var(--err)' }}>
          Aufschlüsselung konnte nicht geladen werden.
        </div>
      ) : storage === null ? (
        <div className="dim" style={{ fontSize: 12 }}>Lade…</div>
      ) : items.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>Keine Snapshots im Retention-Fenster.</div>
      ) : (
        <div className="guest-size-list">
          {display.map((it, i) => {
            const w = Math.max(2, (it.size_b / maxSize) * 100);
            const color = GUEST_PALETTE[i % GUEST_PALETTE.length];
            return (
              <div key={it.target} className="guest-size-row">
                <span className="dot-color" style={{ background: color }} />
                <span className="guest-size-name">{it.target}</span>
                <span className="guest-size-bar"><span style={{ width: `${w}%`, background: color }} /></span>
                <span className="guest-size-val mono">{fmtBytes(it.size_b)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({
  schedule,
  errored,
}: {
  schedule: BackupSchedule | null;
  errored: boolean;
}) {
  const retentionStr = schedule?.retention
    ? Object.entries(schedule.retention)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>Zeitplan &amp; Aufbewahrung</h3>
      </div>
      {errored ? (
        <div className="dim" style={{ fontSize: 12, color: 'var(--err)' }}>
          Schedule nicht ladbar.
        </div>
      ) : schedule === null ? (
        <div className="dim" style={{ fontSize: 12 }}>Lade…</div>
      ) : !schedule.reachable ? (
        <div className="dim" style={{ fontSize: 12, color: 'var(--err)' }}>
          {schedule.error ?? 'PBS unerreichbar'}
        </div>
      ) : !schedule.schedule && !retentionStr ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Keine Prune-Job-Konfiguration für diesen Datastore.
        </div>
      ) : (
        <div className="kv-stack">
          <div className="kv-row">
            <span className="kv-k">Schedule</span>
            <span className="kv-v mono">{schedule.schedule ?? '—'}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Retention</span>
            <span className="kv-v mono" style={{ fontSize: 11 }}>{retentionStr || '—'}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Letzter Erfolg</span>
            <span className="kv-v mono">
              {schedule.last_success_iso ? fmtTimeAgo(schedule.last_success_iso) : '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Donut({
  pct,
  size = 90,
  stroke = 9,
  color,
  label,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color: string;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(pct, 100)) / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {label && (
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={size * 0.24}
          fontWeight={700}
          fill="var(--text-1)"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

// Soll-Anzahl Backup-Jobs pro Tag (12 = 8 LXC/VM-Guests + Reserve), mirror'd from
// the dashboard's expected daily cadence. Bars fill proportionally relative
// to this target so a day with 6/12 jobs shows a 50%-height column.
const JOBS_PER_DAY_TARGET = 12;

interface BackupTrendCardProps {
  heatmap: BackupHeatmap | null;
  loading: boolean;
  errored: boolean;
}

/** 30-Tage-Trend: Erfolg-/Fehler-Balken pro Tag plus GB-Linie als Overlay.
 *
 * Liest die gleichen `cells` wie die Heatmap, fügt aber das `bytes_total`-Feld
 * pro Tag hinzu (Backend-Erweiterung). Skaliert die Balkenhöhe gegen
 * `JOBS_PER_DAY_TARGET` und die Linie gegen `max(bytes_total)`, damit beide
 * Achsen die volle Plot-Höhe nutzen.
 */
function BackupTrendCard({ heatmap, loading, errored }: BackupTrendCardProps) {
  const cells = heatmap?.cells ?? [];
  const totalBytes = cells.reduce((sum, c) => sum + c.bytes_total, 0);
  const daysWithBackups = cells.filter((c) => c.total > 0).length;
  const cleanDays = cells.filter((c) => c.err === 0 && c.total > 0).length;
  const avgGb = daysWithBackups > 0 ? totalBytes / 1024 ** 3 / daysWithBackups : 0;
  const maxBytes = Math.max(1, ...cells.map((c) => c.bytes_total));

  // SVG-Polyline für GB/Tag — viewBox 100×120, preserveAspectRatio="none",
  // damit die Linie genau über den Flex-Balken liegt. 10px Top-Padding,
  // damit Spitzenwerte nicht am Card-Rand kleben.
  const points = cells
    .map((c, i) => {
      const x = cells.length > 1 ? (i / (cells.length - 1)) * 100 : 50;
      const y = 120 - (c.bytes_total / maxBytes) * 100 - 10;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const summaryText =
    cells.length === 0
      ? '—'
      : `${cleanDays}/${cells.length} Tage fehlerfrei · Ø ${avgGb.toFixed(1)} GB/Tag`;

  return (
    <div className="card col-12">
      <div className="card-h">
        <h3>30-Tage-Trend <span className="h3-sub">· Jobs pro Tag + Volumen</span></h3>
        <span className="dimmer mono" style={{ fontSize: 11 }}>{summaryText}</span>
      </div>
      {errored ? (
        <div className="dim" style={{ fontSize: 12, color: 'var(--err)', padding: '20px 0' }}>
          Trend konnte nicht geladen werden.
        </div>
      ) : loading ? (
        <div className="dim" style={{ fontSize: 12, padding: '20px 0' }}>Lade…</div>
      ) : heatmap && !heatmap.reachable ? (
        <div className="dim" style={{ fontSize: 12, color: 'var(--err)', padding: '20px 0' }}>
          {heatmap.error ?? 'PBS unerreichbar'}
        </div>
      ) : (
        <>
          <div className="backup-trend" role="img" aria-label={`Backup-Trend ${cells.length} Tage`}>
            <div className="trend-bars">
              {cells.map((c) => {
                const filled = Math.min(c.total / JOBS_PER_DAY_TARGET, 1) * 100;
                const failPct = c.total > 0 ? (c.err / c.total) * filled : 0;
                const okPct = Math.max(0, filled - failPct);
                return (
                  <div
                    key={c.day}
                    className="trend-col"
                    title={`${c.day} · ${c.ok}/${c.total} ok · ${c.err} fail · ${(c.bytes_total / 1024 ** 3).toFixed(1)} GB`}
                  >
                    {failPct > 0 && <span className="trend-fail" style={{ height: `${failPct}%` }} />}
                    {okPct > 0 && <span className="trend-ok" style={{ height: `${okPct}%` }} />}
                  </div>
                );
              })}
            </div>
            <svg
              className="trend-line"
              width="100%"
              height="120"
              viewBox="0 0 100 120"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.4"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                points={points}
              />
            </svg>
          </div>
          <div className="trend-legend">
            <span><span className="swatch ok" /> Erfolgreich</span>
            <span><span className="swatch err" /> Fehlgeschlagen</span>
            <span><span className="swatch line" /> Volumen GB</span>
          </div>
        </>
      )}
    </div>
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
