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

const FINDING_STATUS_LABEL: Record<AuditFinding['status'], string> = {
  ok: 'OK',
  warn: 'WARN',
  err: 'FEHLER',
  skipped: 'ÜBERSPRUNGEN',
};

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
        <div className="grid-12" style={{ marginBottom: 16 }}>
          <div className="card col-12">
            <div className="card-h">
              <h3>Findings <span className="h3-sub">· {selectedRun.findings.length}</span></h3>
            </div>
            <FindingsList findings={selectedRun.findings} />
          </div>
        </div>
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {run.status === 'running' ? (
            <Dot status="warn" />
          ) : (
            <Dot status={run.status === 'ok' ? 'ok' : run.status === 'warn' ? 'warn' : 'err'} />
          )}
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>
              Audit {STATUS_LABEL[run.status]}
            </div>
            <div className="dim mono" style={{ fontSize: 11 }}>
              {run.id}
            </div>
          </div>
        </div>
        {run.summary && (
          <div style={{ display: 'flex', gap: 14 }}>
            <CountPill label="ok" value={run.summary.ok} tone="ok" />
            <CountPill label="warn" value={run.summary.warn} tone="warn" />
            <CountPill label="err" value={run.summary.err} tone="err" />
            <CountPill label="skipped" value={run.summary.skipped} tone="dim" />
          </div>
        )}
      </div>

      <div className="kv-stack" style={{ marginTop: 14 }}>
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

function FindingsList({ findings }: { findings: AuditFinding[] }) {
  // Sort: errs first, then warns, ok, skipped — most important on top.
  const order: Record<AuditFinding['status'], number> = { err: 0, warn: 1, ok: 2, skipped: 3 };
  const sorted = [...findings].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sorted.map((f) => (
        <FindingRow key={f.id} f={f} />
      ))}
    </ul>
  );
}

function FindingRow({ f }: { f: AuditFinding }) {
  const accent =
    f.status === 'ok'
      ? 'var(--ok)'
      : f.status === 'warn'
        ? 'var(--warn)'
        : f.status === 'err'
          ? 'var(--err)'
          : 'var(--text-4)';
  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 1fr',
        gap: 12,
        padding: '8px 10px',
        borderRadius: 'var(--r-2)',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${accent}`,
        alignItems: 'baseline',
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: accent,
        }}
      >
        {FINDING_STATUS_LABEL[f.status]}
      </span>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{f.title}</div>
        <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{f.detail}</div>
        <div className="mono dimmer" style={{ fontSize: 10, marginTop: 2 }}>{f.id}</div>
      </div>
    </li>
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
