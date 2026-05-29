import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorMessage } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { AuditFinding, AuditRun } from '../types';
import { Dot, ICONS, fmtTimeAgo } from './primitives';

interface Props {
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}

const STATUS_LABEL: Record<AuditRun['status'], string> = {
  running: 'läuft',
  ok: 'erfolgreich',
  warn: 'mit Warnungen',
  err: 'mit Fehlern',
  timeout: 'Timeout',
};

const FINDING_GLYPH: Record<AuditFinding['status'], string> = {
  ok: '✓',
  warn: '!',
  err: '✕',
  skipped: '–',
};

const CATEGORY_LABEL: Record<string, string> = {
  updates: 'Updates',
  hardening: 'Hardening',
  storage: 'Storage',
  backup: 'Backup',
  network: 'Netzwerk',
  zfs: 'ZFS',
  proxmox: 'Proxmox',
  kernel: 'Kernel',
  services: 'Services',
  firewall: 'Firewall',
  ssh: 'SSH',
  apt: 'Updates',
  systemd: 'Services',
};

type Filter = 'all' | 'err' | 'warn' | 'ok';

function statusColor(s: AuditRun['status']): string {
  if (s === 'ok') return 'var(--ok)';
  if (s === 'warn') return 'var(--warn)';
  if (s === 'err' || s === 'timeout') return 'var(--err)';
  return 'var(--info)';
}

function fmtDuration(start: number, end: number | null): string {
  if (!end) return '—';
  const ms = (end - start) * 1000;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Health score 0–100. ok counts full, warn half, err zero. skipped excluded.
 * Returns null when there's nothing to grade yet (no findings at all). */
function calcScore(summary: AuditRun['summary']): number | null {
  if (!summary) return null;
  const graded = summary.ok + summary.warn + summary.err;
  if (graded === 0) return null;
  return Math.round(((summary.ok + summary.warn * 0.5) / graded) * 100);
}

function scoreNote(score: number): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

function scoreTone(score: number): 'ok' | 'warn' | 'err' {
  if (score >= 85) return 'ok';
  if (score >= 65) return 'warn';
  return 'err';
}

/** Resolve a category for a finding — explicit ``category`` wins, otherwise
 * derive from the leading dot-segment of ``id`` (e.g. ``updates`` from
 * ``updates.security_pending``). Falls back to ``Allgemein``. */
function categoryOf(f: AuditFinding): string {
  if (f.category && f.category.trim()) return f.category.trim();
  const head = f.id.split(/[.:_/-]/)[0]?.toLowerCase();
  if (!head) return 'Allgemein';
  return CATEGORY_LABEL[head] ?? head.charAt(0).toUpperCase() + head.slice(1);
}

export function AuditPanel({ onError, onInfo }: Props) {
  const [busy, setBusy] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  // Faster polling while an audit is in flight; otherwise idle refresh.
  const pollInterval = currentJobId ? 1500 : 20000;
  const jobsPoll = usePoll(
    (signal) => api.auditJobs(20, signal),
    pollInterval,
    [pollInterval],
  );

  useEffect(() => {
    if (jobsPoll.data) setCurrentJobId(jobsPoll.data.current_job_id);
  }, [jobsPoll.data]);

  const jobs = useMemo<AuditRun[]>(() => jobsPoll.data?.jobs ?? [], [jobsPoll.data]);

  const selectedRun: AuditRun | null = useMemo(() => {
    if (jobs.length === 0) return null;
    if (selectedJobId) {
      return jobs.find((j) => j.id === selectedJobId) ?? jobs[0];
    }
    return jobs[0];
  }, [jobs, selectedJobId]);

  // Drop the cached log when the selection switches.
  useEffect(() => {
    setExpandedLog(null);
  }, [selectedRun?.id]);

  const startAudit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.auditRun();
      onInfo(`Audit gestartet (${r.job_id})`);
      setSelectedJobId(r.job_id);
      jobsPoll.refresh();
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, onInfo, onError, jobsPoll]);

  const loadLog = useCallback(async () => {
    if (!selectedRun) return;
    setLogLoading(true);
    try {
      const detail = await api.auditJob(selectedRun.id);
      setExpandedLog(detail.log_output ?? '');
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setLogLoading(false);
    }
  }, [selectedRun, onError]);

  const isRunning = !!currentJobId;
  const startDisabled = busy || isRunning;

  return (
    <section className="audit-section">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2>
          Audit{' '}
          {jobs.length > 0 && (
            <span className="count">· {jobs.length} {jobs.length === 1 ? 'Lauf' : 'Läufe'}</span>
          )}
        </h2>
        <div className="section-tools">
          <button
            className="btn primary"
            type="button"
            onClick={startAudit}
            disabled={startDisabled}
            title={isRunning ? 'Es läuft bereits ein Audit' : undefined}
          >
            {ICONS.zap} {isRunning ? 'Audit läuft…' : busy ? 'Starte…' : 'Audit starten'}
          </button>
        </div>
      </div>

      {selectedRun && (
        <div className="grid-12" style={{ marginBottom: 16 }}>
          <div className="col-12">
            <AuditSummaryBand run={selectedRun} />
          </div>
        </div>
      )}

      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12">
          {selectedRun ? (
            <RunSummary
              run={selectedRun}
              onShowLog={loadLog}
              logLoading={logLoading}
              expandedLog={expandedLog}
              onHideLog={() => setExpandedLog(null)}
            />
          ) : (
            <div className="dim" style={{ fontSize: 13 }}>
              {'Noch kein Audit ausgeführt. Klicke „Audit starten", um den ersten Lauf anzustoßen.'}
            </div>
          )}
        </div>
      </div>

      {selectedRun && selectedRun.findings.length > 0 && (
        <FindingsByCategory findings={selectedRun.findings} />
      )}

      {jobs.length > 1 && (
        <div className="grid-12">
          <div className="card col-12" style={{ padding: 0 }}>
            <div style={{ padding: '18px 20px 0' }}>
              <div className="card-h" style={{ marginBottom: 0 }}>
                <h3>Historie <span className="h3-sub">· letzte {jobs.length}</span></h3>
              </div>
            </div>
            <HistoryTable
              jobs={jobs}
              selectedId={selectedRun?.id ?? null}
              onSelect={setSelectedJobId}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function RunSummary({
  run,
  onShowLog,
  logLoading,
  expandedLog,
  onHideLog,
}: {
  run: AuditRun;
  onShowLog: () => void;
  logLoading: boolean;
  expandedLog: string | null;
  onHideLog: () => void;
}) {
  const color = statusColor(run.status);
  return (
    <>
      <div className="card-h">
        <h3>Lauf-Details <span className="h3-sub mono">· {run.id}</span></h3>
      </div>

      <div className="kv-stack">
        <div className="kv-row">
          <span className="kv-k">Gestartet</span>
          <span className="kv-v mono">{fmtTimeAgo(new Date(run.started_at * 1000).toISOString())}</span>
        </div>
        <div className="kv-row">
          <span className="kv-k">Dauer</span>
          <span className="kv-v mono">{fmtDuration(run.started_at, run.finished_at)}</span>
        </div>
        <div className="kv-row">
          <span className="kv-k">Ausführungsort</span>
          <span className="kv-v mono">{run.location}</span>
        </div>
        <div className="kv-row">
          <span className="kv-k">Gestartet von</span>
          <span className="kv-v mono">{run.started_by ?? '—'}</span>
        </div>
        {run.exit_code !== null && (
          <div className="kv-row">
            <span className="kv-k">Exit-Code</span>
            <span className="kv-v mono" style={{ color: run.exit_code === 0 ? 'var(--text-2)' : color }}>
              {run.exit_code}
            </span>
          </div>
        )}
      </div>

      {run.error && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 12px',
            borderRadius: 'var(--r-2)',
            background: 'var(--err-soft)',
            color: 'var(--err)',
            fontSize: 12.5,
          }}
        >
          {run.error}
        </div>
      )}

      {run.status !== 'running' && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          {expandedLog === null ? (
            <button className="btn sm" type="button" onClick={onShowLog} disabled={logLoading}>
              {ICONS.logs} {logLoading ? 'Lade…' : 'Log anzeigen'}
            </button>
          ) : (
            <button className="btn sm" type="button" onClick={onHideLog}>
              Log ausblenden
            </button>
          )}
        </div>
      )}

      {expandedLog !== null && (
        <pre
          style={{
            marginTop: 10,
            padding: 12,
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-2)',
            maxHeight: 320,
            overflow: 'auto',
            fontSize: 11.5,
            lineHeight: 1.45,
            color: 'var(--text-2)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {expandedLog || '(leere Ausgabe)'}
        </pre>
      )}
    </>
  );
}

function CountPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'err' | 'dim';
}) {
  const color =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : 'var(--text-3)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: value > 0 ? color : 'var(--text-4)' }}>
        {value}
      </span>
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-4)' }}>
        {label}
      </span>
    </div>
  );
}

function AuditSummaryBand({ run }: { run: AuditRun }) {
  const summary = run.summary;
  const score = calcScore(summary);
  const tone =
    run.status === 'running'
      ? 'warn'
      : score !== null
        ? scoreTone(score)
        : run.status === 'ok'
          ? 'ok'
          : run.status === 'warn'
            ? 'warn'
            : 'err';
  const note = score !== null ? scoreNote(score) : '—';
  const title = `Proxmox-Audit${score !== null ? ` · ${score}/100` : ''}`;
  const verdict = summary
    ? `${summary.ok} bestanden · ${summary.warn} Warnungen · ${summary.err} kritisch · ${summary.ok + summary.warn + summary.err + summary.skipped} Checks`
    : `Audit ${STATUS_LABEL[run.status]}`;

  return (
    <div className={`audit-summary tone-${tone}`}>
      <div className={`audit-score tone-${tone}`} aria-label={`Note ${note}`}>
        {note}
      </div>
      <div className="verdict-main">
        <h3>{title}</h3>
        <p>{verdict}</p>
      </div>
      <div className="verdict-pills">
        {summary && (
          <>
            <CountPill label="ok" value={summary.ok} tone="ok" />
            <CountPill label="warn" value={summary.warn} tone="warn" />
            <CountPill label="err" value={summary.err} tone="err" />
            <CountPill label="skipped" value={summary.skipped} tone="dim" />
          </>
        )}
      </div>
    </div>
  );
}

const FILTER_OPTIONS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'err', label: 'Kritisch' },
  { id: 'warn', label: 'Warnungen' },
  { id: 'ok', label: 'Bestanden' },
];

function FindingsByCategory({ findings }: { findings: AuditFinding[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  // err first, then warn, ok, skipped — most important on top.
  const order: Record<AuditFinding['status'], number> = { err: 0, warn: 1, ok: 2, skipped: 3 };
  const passesFilter = (f: AuditFinding) =>
    filter === 'all' ? true : filter === f.status;

  const filtered = findings.filter(passesFilter);

  // Group by category, preserve original order within a group, sort groups by
  // worst-status (err first) then by name.
  const groups = useMemo(() => {
    const byCat = new Map<string, AuditFinding[]>();
    for (const f of filtered) {
      const cat = categoryOf(f);
      const bucket = byCat.get(cat) ?? [];
      bucket.push(f);
      byCat.set(cat, bucket);
    }
    const arr = Array.from(byCat.entries()).map(([name, items]) => ({
      name,
      items: [...items].sort((a, b) => order[a.status] - order[b.status]),
      worst: items.reduce(
        (acc, f) => Math.min(acc, order[f.status]),
        order.skipped,
      ),
    }));
    arr.sort((a, b) => a.worst - b.worst || a.name.localeCompare(b.name, 'de'));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length, filter]);

  const counts = {
    all: findings.length,
    err: findings.filter((f) => f.status === 'err').length,
    warn: findings.filter((f) => f.status === 'warn').length,
    ok: findings.filter((f) => f.status === 'ok').length,
  };

  return (
    <div className="grid-12" style={{ marginBottom: 16 }}>
      <div className="col-12">
        <div className="dash-section-head" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
            Findings <span className="h3-sub">· {findings.length}</span>
          </h3>
          <div className="seg-control" role="tablist" aria-label="Findings filtern">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={filter === opt.id}
                className={`seg-btn ${filter === opt.id ? 'active' : ''}`}
                onClick={() => setFilter(opt.id)}
              >
                {opt.label}
                <span className="dimmer" style={{ marginLeft: 4 }}>
                  ({counts[opt.id]})
                </span>
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="card col-12 dim" style={{ fontSize: 12.5 }}>
            Keine Findings in diesem Filter.
          </div>
        ) : (
          <div className="cat-grid">
            {groups.map((g) => (
              <div key={g.name} className="card">
                <div className="card-h">
                  <h3>
                    {g.name} <span className="h3-sub">· {g.items.length}</span>
                  </h3>
                </div>
                <div className="acheck-list">
                  {g.items.map((f) => (
                    <AuditCheck key={f.id} f={f} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AuditCheck({ f }: { f: AuditFinding }) {
  return (
    <div className={`acheck tone-${f.status}`}>
      <div className={`acheck-ico tone-${f.status}`} aria-hidden="true">
        {FINDING_GLYPH[f.status]}
      </div>
      <div className="acheck-body">
        <div className="acheck-title">{f.title}</div>
        {f.detail && <div className="acheck-detail">{f.detail}</div>}
        <div className="acheck-id">{f.id}</div>
        {f.fix && (
          <div className="acheck-fix">
            <span className="fix-tag">FIX</span>
            <code>{f.fix}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryTable({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: AuditRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <table className="job-table">
      <thead>
        <tr>
          <th style={{ width: 28 }}></th>
          <th>Wann</th>
          <th>Status</th>
          <th>Findings</th>
          <th>Dauer</th>
          <th>Gestartet von</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const dot: 'ok' | 'warn' | 'err' =
            j.status === 'ok' ? 'ok' : j.status === 'warn' ? 'warn' : 'err';
          const isSelected = j.id === selectedId;
          return (
            <tr
              key={j.id}
              onClick={() => onSelect(j.id)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(j.id);
                }
              }}
              style={{
                cursor: 'pointer',
                background: isSelected ? 'var(--surface-3)' : undefined,
              }}
              aria-current={isSelected ? 'true' : undefined}
            >
              <td>{j.status === 'running' ? <Dot status="warn" /> : <Dot status={dot} />}</td>
              <td className="mono">{fmtTimeAgo(new Date(j.started_at * 1000).toISOString())}</td>
              <td>
                <span
                  className="mono"
                  style={{ fontSize: 11, fontWeight: 600, color: statusColor(j.status) }}
                >
                  {STATUS_LABEL[j.status]}
                </span>
              </td>
              <td className="mono">
                {j.summary ? (
                  <>
                    <span style={{ color: 'var(--ok)' }}>{j.summary.ok}</span>
                    {' / '}
                    <span style={{ color: 'var(--warn)' }}>{j.summary.warn}</span>
                    {' / '}
                    <span style={{ color: 'var(--err)' }}>{j.summary.err}</span>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className="mono dim">{fmtDuration(j.started_at, j.finished_at)}</td>
              <td className="mono dim">{j.started_by ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
