import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Guest, GuestTask } from '../types';
import { Dot, ICONS, fmtBytes, fmtTimeAgo, fmtUptime } from './primitives';

interface Props {
  open: boolean;
  guest: Guest | null;
  onClose: () => void;
  onRestart: (g: Guest) => void;
}

/**
 * Drawer for a single Proxmox guest. Shows live status (from the parent's
 * polling), recent tasks, and host-journal entries filtered by VMID.
 *
 * The "Live-Logs" label is honest: PVE does not expose container-internal
 * ``journalctl`` over its API, so this view aggregates host-side lifecycle
 * events for that VMID and the task log archive. For shell-level container
 * logs the operator still needs SSH on the Proxmox host.
 */
export function GuestDrawer({ open, guest, onClose, onRestart }: Props) {
  const [tasks, setTasks] = useState<GuestTask[]>([]);
  const [tasksErr, setTasksErr] = useState(false);
  const [journal, setJournal] = useState<string[]>([]);
  const [journalErr, setJournalErr] = useState(false);
  const [journalLoading, setJournalLoading] = useState(true);

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

  if (!guest) return null;

  const ramPct = guest.ram_total_b ? (guest.ram_used_b / guest.ram_total_b) * 100 : 0;

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
            </div>
            <div>
              <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                RAM
              </span>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {ramPct.toFixed(0)}%
              </div>
              <div className="dim mono" style={{ fontSize: 11 }}>
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
            <div className="drawer-section-head">
              <h3>Host-Journal · gefiltert nach VMID {guest.id}</h3>
              <span className="dimmer mono" style={{ fontSize: 11 }}>
                auto · 5s
              </span>
            </div>
            <pre className="journal-pre" aria-live="polite">
              {journalLoading && journal.length === 0 && <span className="dimmer">Lade Journal…</span>}
              {journalErr && <span style={{ color: 'var(--err)' }}>Journal konnte nicht geladen werden — PVE-Token braucht Sys.Audit.</span>}
              {!journalLoading && !journalErr && journal.length === 0 && (
                <span className="dimmer">Keine Einträge mit Bezug zu VMID {guest.id} im aktuellen Buffer.</span>
              )}
              {journal.map((line, i) => (
                <div key={`${i}-${line.slice(0, 24)}`} className="journal-line">{line}</div>
              ))}
            </pre>
            <div className="dimmer" style={{ fontSize: 11, marginTop: 6 }}>
              Hinweis: PVE bietet kein Container-internes <code>journalctl</code> über die API. Hier siehst du
              Host-Events (pveproxy, pve-container, systemd) mit Bezug zu dieser VMID.
            </div>
          </div>

          <div className="drawer-section">
            <h3>Letzte Tasks</h3>
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
