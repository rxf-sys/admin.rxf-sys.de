import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { BackupSnapshot, Guest, GuestHistory, GuestTask } from '../types';
import { Dot, ICONS, Sparkline, fmtBytes, fmtTimeAgo, fmtUptime } from './primitives';

interface Props {
  open: boolean;
  guest: Guest | null;
  onClose: () => void;
  onRestart: (g: Guest) => void;
}

/**
 * Drawer for a single Proxmox guest. Shows live status (from the parent's
 * polling), CPU/RAM trends sampled by the backend metrics loop, recent
 * PVE tasks, last PBS backups, and host-journal entries filtered by VMID.
 *
 * The "journalctl" label is qualified: PVE does not expose container-internal
 * journalctl over its API, so this view aggregates *host-side* lifecycle
 * events for that VMID. For shell-level container logs operators still need
 * SSH on the Proxmox host.
 */
export function GuestDrawer({ open, guest, onClose, onRestart }: Props) {
  const [tasks, setTasks] = useState<GuestTask[]>([]);
  const [tasksErr, setTasksErr] = useState(false);
  const [journal, setJournal] = useState<string[]>([]);
  const [journalErr, setJournalErr] = useState(false);
  const [journalLoading, setJournalLoading] = useState(true);
  const [history, setHistory] = useState<GuestHistory | null>(null);
  const [backups, setBackups] = useState<BackupSnapshot[] | null>(null);
  const [backupsErr, setBackupsErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !guest) {
      setTasks([]);
      setTasksErr(false);
      setHistory(null);
      setBackups(null);
      return;
    }
    const ctrl = new AbortController();
    api
      .guestTasks(guest.id, ctrl.signal)
      .then((r) => {
        setTasks(r.tasks);
        setTasksErr(false);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setTasksErr(true);
      });
    api
      .guestHistory(guest.id, 24, ctrl.signal)
      .then(setHistory)
      .catch(() => {
        if (!ctrl.signal.aborted) setHistory(null);
      });
    api
      .guestBackups(guest.id, 5, ctrl.signal)
      .then((r) => {
        setBackups(r.jobs);
        setBackupsErr(r.reachable ? null : (r.error ?? 'PBS unerreichbar'));
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setBackups([]);
        setBackupsErr(e.message);
      });
    return () => ctrl.abort();
  }, [open, guest]);

  // Poll the host journal every 5s while the drawer is open.
  useEffect(() => {
    if (!open || !guest) {
      setJournal([]);
      setJournalLoading(true);
      return;
    }
    let cancelled = false;
    const load = async (initial = false) => {
      const ctrl = new AbortController();
      try {
        const r = await api.guestJournal(guest.id, 500, ctrl.signal);
        if (cancelled) return;
        setJournal(r.lines);
        setJournalErr(false);
      } catch {
        if (cancelled) return;
        setJournalErr(true);
      } finally {
        if (initial && !cancelled) setJournalLoading(false);
      }
      return () => ctrl.abort();
    };
    void load(true);
    const t = setInterval(() => void load(false), 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, guest]);

  const cpuSeries = useMemo(
    () => (history?.samples ?? []).map((s) => s.cpu_pct),
    [history],
  );
  const ramSeries = useMemo(
    () =>
      (history?.samples ?? []).map((s) =>
        s.ram_total_b ? (s.ram_used_b / s.ram_total_b) * 100 : 0,
      ),
    [history],
  );

  if (!guest) return null;

  const ramPct = guest.ram_total_b ? (guest.ram_used_b / guest.ram_total_b) * 100 : 0;
  const journalTail = journal.slice(-4);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open} aria-label={`Logs ${guest.name}`}>
        <div className="drawer-h">
          <span className="svc-icon" style={{ width: 36, height: 36 }}>{ICONS.server}</span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>{guest.name}</h2>
              <Dot status={guest.status} />
              <span className={`type-pill type-${guest.type.toLowerCase()}`}>{guest.type}</span>
              <span className={`badge ${guest.running ? 'ok' : 'idle'}`}>
                {guest.running ? 'RUNNING' : 'STOPPED'}
              </span>
            </div>
            <span className="mono drawer-link">
              {guest.id} · {guest.ip ?? '—'} · {guest.service ?? 'no service tag'}
            </span>
          </div>
          <button className="btn icon" onClick={onClose} title="Close" type="button">
            {ICONS.close}
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-summary">
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                CPU
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {guest.cpu_pct.toFixed(1)}%
              </div>
              <div className="bar" style={{ marginTop: 4, minWidth: 0 }}>
                <div
                  className="bar-fill"
                  style={{
                    width: `${Math.min(100, guest.cpu_pct)}%`,
                    background:
                      guest.cpu_pct > 80 ? 'var(--err)' : guest.cpu_pct > 60 ? 'var(--warn)' : 'var(--ok)',
                  }}
                />
              </div>
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                RAM
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {ramPct.toFixed(0)}%
              </div>
              <div className="bar" style={{ marginTop: 4, minWidth: 0 }}>
                <div
                  className="bar-fill"
                  style={{
                    width: `${Math.min(100, ramPct)}%`,
                    background:
                      ramPct > 80 ? 'var(--err)' : ramPct > 60 ? 'var(--warn)' : 'var(--ok)',
                  }}
                />
              </div>
              <div className="dim mono" style={{ fontSize: 11, marginTop: 4 }}>
                {fmtBytes(guest.ram_used_b)} / {fmtBytes(guest.ram_total_b)}
              </div>
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Uptime
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {fmtUptime(guest.uptime_s)}
              </div>
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Status
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {guest.running ? 'running' : 'stopped'}
              </div>
            </div>
          </div>

          <div className="drawer-section">
            <h3>Resource Trends · 24h</h3>
            <TrendsBlock
              enabled={history?.enabled ?? true}
              cpu={cpuSeries}
              ram={ramSeries}
            />
          </div>

          <div className="drawer-section">
            <h3>Container · Konfiguration</h3>
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
                <span className="dim">Hostname</span>
                <span className="mono">{guest.name}</span>
              </div>
              <div>
                <span className="dim">Service</span>
                <span>{guest.service ?? '—'}</span>
              </div>
              <div>
                <span className="dim">Status</span>
                <span className="mono">{guest.running ? 'running' : 'stopped'}</span>
              </div>
            </div>
          </div>

          <div className="drawer-section">
            <div className="drawer-section-head">
              <h3>journalctl · Host-Journal · gefiltert nach VMID {guest.id}</h3>
              <span className="dimmer mono" style={{ fontSize: 11 }}>
                auto · 5s · letzte 4
              </span>
            </div>
            <pre className="journal-pre" aria-live="polite">
              {journalLoading && journal.length === 0 && <span className="dimmer">Lade Journal…</span>}
              {journalErr && <span style={{ color: 'var(--err)' }}>Journal konnte nicht geladen werden — PVE-Token braucht Sys.Audit.</span>}
              {!journalLoading && !journalErr && journal.length === 0 && (
                <span className="dimmer">Keine Einträge mit Bezug zu VMID {guest.id} im aktuellen Buffer.</span>
              )}
              {journalTail.map((line, i) => (
                <div key={`${i}-${line.slice(0, 24)}`} className="journal-line">{line}</div>
              ))}
            </pre>
            <div className="dimmer" style={{ fontSize: 11, marginTop: 6 }}>
              Hinweis: PVE bietet kein Container-internes <code>journalctl</code> über die API. Hier siehst du
              Host-Events (pveproxy, pve-container, systemd) mit Bezug zu dieser VMID.
            </div>
          </div>

          <div className="drawer-section">
            <h3>Letzte 5 Backups (PBS)</h3>
            <BackupsBlock backups={backups} error={backupsErr} />
          </div>

          <div className="drawer-section">
            <h3>Letzte Tasks (PVE)</h3>
            {tasksErr ? (
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
        </div>

        <div className="drawer-foot">
          <button
            className="btn danger"
            onClick={() => onRestart(guest)}
            disabled={!guest.running}
            type="button"
          >
            {ICONS.restart} Neu starten
          </button>
        </div>
      </aside>
    </>
  );
}

function TrendsBlock({
  enabled,
  cpu,
  ram,
}: {
  enabled: boolean;
  cpu: number[];
  ram: number[];
}) {
  if (!enabled) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Metrik-Historie deaktiviert — <span className="mono">STORAGE_DB_PATH</span> nicht gesetzt.
      </div>
    );
  }
  if (cpu.length < 2 || ram.length < 2) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Sammle Verlauf — Sampling-Loop läuft alle 60 s.
      </div>
    );
  }
  return (
    <div className="trends-grid">
      <div className="trend-card">
        <div className="trend-head">
          <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            CPU
          </span>
          <span className="mono" style={{ fontSize: 12 }}>
            jetzt <strong>{cpu[cpu.length - 1].toFixed(1)}%</strong>
          </span>
        </div>
        <Sparkline data={cpu} color="var(--accent)" width={260} height={56} />
      </div>
      <div className="trend-card">
        <div className="trend-head">
          <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            RAM
          </span>
          <span className="mono" style={{ fontSize: 12 }}>
            jetzt <strong>{ram[ram.length - 1].toFixed(0)}%</strong>
          </span>
        </div>
        <Sparkline data={ram} color="var(--info)" width={260} height={56} />
      </div>
    </div>
  );
}

function BackupsBlock({
  backups,
  error,
}: {
  backups: BackupSnapshot[] | null;
  error: string | null;
}) {
  if (backups === null) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Lade…
      </div>
    );
  }
  if (error) {
    return (
      <div className="dimmer" style={{ fontSize: 12, color: 'var(--err)' }}>
        {error}
      </div>
    );
  }
  if (backups.length === 0) {
    return (
      <div className="dimmer" style={{ fontSize: 12 }}>
        Keine Backups für diesen Guest gefunden.
      </div>
    );
  }
  return (
    <table className="mini-table">
      <tbody>
        {backups.map((b) => (
          <tr key={b.id}>
            <td style={{ width: 16 }}>
              <Dot status={b.status} />
            </td>
            <td className="mono dim" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              {b.backup_type}/{b.backup_id}
            </td>
            <td className="mono" style={{ fontSize: 11, textAlign: 'right' }}>
              {fmtBytes(b.size_b)}
            </td>
            <td className={`verify ${b.verify}`} style={{ minWidth: 60 }}>
              {b.verify}
            </td>
            <td className="mono dim" style={{ fontSize: 11, whiteSpace: 'nowrap', textAlign: 'right' }}>
              {fmtTimeAgo(b.when_iso)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
        <span className="mono dim" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {fmtTimeAgo(task.starttime ? new Date(task.starttime * 1000).toISOString() : null)}
        </span>
        <span className="task-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
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
