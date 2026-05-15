import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Guest, GuestTask, ServiceHistory, ServiceStatus } from '../types';
import { Dot, ICONS, Num, Sparkline, fmtTimeAgo, fmtUptime } from './primitives';
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
  const [tasks, setTasks] = useState<GuestTask[]>([]);
  const [tasksError, setTasksError] = useState(false);
  const [history, setHistory] = useState<ServiceHistory | null>(null);
  const [historyHours, setHistoryHours] = useState<number>(24);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Heuristic: find the guest most likely backing this service.
  const guest = svc
    ? guests.find((g) => (g.service ?? '').toLowerCase().includes(svc.id)) ??
      guests.find((g) => g.name.toLowerCase().includes(svc.id))
    : undefined;

  useEffect(() => {
    if (!open || !guest) {
      setTasks([]);
      setTasksError(false);
      return;
    }
    const ctrl = new AbortController();
    api
      .guestTasks(guest.id, ctrl.signal)
      .then((r) => {
        setTasks(r.tasks);
        setTasksError(false);
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setTasksError(true);
        setTasks([]);
        // eslint-disable-next-line no-console
        console.warn('tasks fetch failed', e);
      });
    return () => ctrl.abort();
  }, [open, guest]);

  useEffect(() => {
    if (!open || !svc) {
      setHistory(null);
      return;
    }
    const ctrl = new AbortController();
    api
      .serviceHistory(svc.id, historyHours, ctrl.signal)
      .then((h) => setHistory(h))
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setHistory(null);
        // eslint-disable-next-line no-console
        console.warn('history fetch failed', e);
      });
    return () => ctrl.abort();
  }, [open, svc, historyHours]);

  if (!svc) return null;

  const data = getServiceHistory(svc.id);
  const sparkColor =
    svc.status === 'warn' ? 'var(--warn)' : svc.status === 'err' ? 'var(--err)' : 'var(--accent)';
  const sorted = [...data].sort((a, b) => a - b);
  const min = data.length ? Math.min(...data) : 0;
  const max = data.length ? Math.max(...data) : 0;
  const avg = data.length ? data.reduce((a, b) => a + b, 0) / data.length : 0;
  const p95 = data.length ? sorted[Math.floor(data.length * 0.95)] ?? max : 0;

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

          <div className="drawer-section">
            <div className="drawer-section-head">
              <h3>Verlauf · persistent</h3>
              <select
                className="hours-select"
                value={historyHours}
                onChange={(e) => setHistoryHours(Number(e.target.value))}
                aria-label="Zeitraum"
              >
                <option value={1}>1h</option>
                <option value={6}>6h</option>
                <option value={24}>24h</option>
                <option value={72}>3d</option>
                <option value={168}>7d</option>
              </select>
            </div>
            <HistoryView history={history} />
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

          {guest && (
            <div className="drawer-section">
              <h3>Letzte Tasks</h3>
              {tasksError ? (
                <div className="dimmer" style={{ fontSize: 12 }}>
                  Tasks konnten nicht geladen werden.
                </div>
              ) : tasks.length === 0 ? (
                <div className="dimmer" style={{ fontSize: 12 }}>
                  Keine Tasks gefunden.
                </div>
              ) : (
                <div className="event-list">
                  {tasks.map((t) => (
                    <TaskRow key={t.upid ?? `${t.starttime}-${t.type}`} task={t} />
                  ))}
                </div>
              )}
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

function HistoryView({ history }: { history: ServiceHistory | null }) {
  if (history === null) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Lade…
      </div>
    );
  }
  if (!history.enabled) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Probe-History deaktiviert — <span className="mono">STORAGE_DB_PATH</span> nicht gesetzt.
      </div>
    );
  }
  if (history.samples.length === 0) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Noch keine Daten — Sammlung beginnt mit dem ersten Probe-Lauf.
      </div>
    );
  }
  // Bucket samples into a fixed-width stripe so the same component scales
  // across "1h" (≈ 240 samples) and "7d" (≈ 40k).
  const TARGET_BUCKETS = 60;
  const buckets: ('ok' | 'warn' | 'err' | 'idle')[] = new Array(TARGET_BUCKETS).fill('idle');
  const oldest = history.samples[0].ts;
  const newest = history.samples[history.samples.length - 1].ts;
  const span = Math.max(1, newest - oldest);
  for (const s of history.samples) {
    const idx = Math.min(TARGET_BUCKETS - 1, Math.floor(((s.ts - oldest) / span) * TARGET_BUCKETS));
    // Worst status wins within a bucket so a single err isn't masked by ok.
    const order = { ok: 0, idle: 1, warn: 2, err: 3 } as const;
    if (order[s.status] >= order[buckets[idx]]) buckets[idx] = s.status;
  }
  const msValues = history.samples.map((s) => s.ms);
  const avg = Math.round(msValues.reduce((a, b) => a + b, 0) / msValues.length);
  return (
    <>
      <div className="history-stripe" role="img" aria-label="Status-Verlauf">
        {buckets.map((b, i) => (
          <span key={i} className={`status-cell ${b}`} />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginTop: 8,
          fontSize: 11,
          color: 'var(--text-3)',
        }}
      >
        <span className="mono">
          Uptime{' '}
          <strong style={{ color: 'var(--text-1)' }}>
            {history.uptime_pct == null ? '—' : `${history.uptime_pct.toFixed(2)}%`}
          </strong>
        </span>
        <span className="mono">
          Samples <strong style={{ color: 'var(--text-1)' }}>{history.samples.length}</strong>
        </span>
        <span className="mono">
          Ø Antwort <strong style={{ color: 'var(--text-1)' }}>{avg}ms</strong>
        </span>
      </div>
    </>
  );
}

function TaskRow({ task }: { task: GuestTask }) {
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<{ n: number; t: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const ok = task.status === 'OK' || task.status === 'stopped';
  const running = !task.endtime;
  const dotStatus: 'ok' | 'warn' | 'err' = running ? 'warn' : ok ? 'ok' : 'err';

  useEffect(() => {
    if (!expanded || !task.upid || lines !== null) return;
    setLoading(true);
    setError(false);
    const ctrl = new AbortController();
    api
      .taskLog(task.upid, ctrl.signal)
      .then((r) => setLines(r.lines))
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [expanded, task.upid, lines]);

  return (
    <div className="task-row">
      <button
        className="task-row-head"
        onClick={() => task.upid && setExpanded((x) => !x)}
        disabled={!task.upid}
        type="button"
        aria-expanded={expanded}
      >
        <Dot status={dotStatus} />
        <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
          {task.type ?? '—'}
        </span>
        <span className="dim mono" style={{ fontSize: 11 }}>
          {task.user ?? '—'}
        </span>
        <span
          className="mono dim"
          style={{ fontSize: 11, marginLeft: 'auto' }}
          title={task.upid ?? ''}
        >
          {fmtTimeAgo(task.starttime ? new Date(task.starttime * 1000).toISOString() : null)}
        </span>
        <span className="task-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <pre className="task-log">
          {loading && <span className="dimmer">Lade Log…</span>}
          {error && <span style={{ color: 'var(--err)' }}>Log konnte nicht geladen werden.</span>}
          {lines && lines.length === 0 && !loading && !error && (
            <span className="dimmer">Keine Log-Zeilen.</span>
          )}
          {lines && lines.map((l) => `${l.t}\n`).join('')}
        </pre>
      )}
    </div>
  );
}
