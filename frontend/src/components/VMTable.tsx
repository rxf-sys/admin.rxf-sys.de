import { useMemo, useState } from 'react';
import type { Guest } from '../types';
import { Dot, ICONS, fmtUptime } from './primitives';

interface Props {
  guests: Guest[];
  onLogs: (g: Guest) => void;
  onRestart: (g: Guest) => void;
  isAdmin?: boolean;
  onRenameService?: (vmid: number, name: string) => void;
  onQuickAddService?: (g: Guest) => void;
}

type SortKey = 'id' | 'name' | 'ip' | 'cpu' | 'ram' | 'uptime';

export function VMTable({ guests, onLogs, onRestart, isAdmin, onRenameService, onQuickAddService }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'id', dir: 'asc' });
  const [filter, setFilter] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);

  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    let arr = guests.filter(
      (v) =>
        (!runningOnly || v.running) &&
        (!f ||
          v.name.toLowerCase().includes(f) ||
          (v.service ?? '').toLowerCase().includes(f) ||
          String(v.id).includes(f) ||
          (v.ip ?? '').includes(f)),
    );
    arr = [...arr].sort((a, b) => {
      const va: string | number =
        sort.key === 'cpu'
          ? a.cpu_pct
          : sort.key === 'ram'
            ? a.ram_total_b ? (a.ram_used_b / a.ram_total_b) * 100 : 0
            : sort.key === 'uptime'
              ? a.uptime_s
              : (a as unknown as Record<string, string | number>)[sort.key] ?? '';
      const vb: string | number =
        sort.key === 'cpu'
          ? b.cpu_pct
          : sort.key === 'ram'
            ? b.ram_total_b ? (b.ram_used_b / b.ram_total_b) * 100 : 0
            : sort.key === 'uptime'
              ? b.uptime_s
              : (b as unknown as Record<string, string | number>)[sort.key] ?? '';
      if (va < vb) return sort.dir === 'asc' ? -1 : 1;
      if (va > vb) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [guests, sort, filter, runningOnly]);

  const toggle = (k: SortKey) =>
    setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }));

  const Th = ({ k, children, align }: { k: SortKey; children: React.ReactNode; align?: 'left' | 'right' }) => (
    <th onClick={() => toggle(k)} style={{ textAlign: align ?? 'left', cursor: 'pointer' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {children}
        {sort.key === k && <span style={{ fontSize: 9, opacity: 0.6 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  );

  return (
    <section className="vm-section">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2>
          Container &amp; VMs <span className="count">· {sorted.length} / {guests.length}</span>
        </h2>
        <div className="section-tools">
          <label className="toggle-pill" title="Nur laufende Container anzeigen">
            <input
              type="checkbox"
              checked={runningOnly}
              onChange={(e) => setRunningOnly(e.target.checked)}
              aria-label="Nur laufende Container anzeigen"
            />
            <span>Nur laufende</span>
          </label>
          <input
            className="input"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: 180 }}
          />
        </div>
      </div>
      <div className="vm-table-wrap">
        <table className="vm-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <Th k="id">ID</Th>
              <Th k="name">Name</Th>
              <th>Type</th>
              <Th k="ip">IP</Th>
              <th>Service</th>
              <Th k="cpu" align="right">
                CPU
              </Th>
              <Th k="ram" align="right">
                RAM
              </Th>
              <Th k="uptime" align="right">
                Uptime
              </Th>
              <th style={{ width: isAdmin ? 122 : 90, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => {
              const ramPct = v.ram_total_b ? (v.ram_used_b / v.ram_total_b) * 100 : 0;
              const ramBar = Math.min(100, ramPct);
              const rowClass =
                v.status === 'err' ? 'attn' : v.status === 'warn' ? 'warn-row' : '';
              const onRowClick = () => onLogs(v);
              const onRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onLogs(v);
                }
              };
              return (
                <tr
                  key={v.id}
                  className={rowClass}
                  onClick={onRowClick}
                  onKeyDown={onRowKey}
                  tabIndex={0}
                  role="button"
                  aria-label={`Details für ${v.name} öffnen`}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <Dot status={v.status} />
                  </td>
                  <td className="mono dim">{v.id}</td>
                  <td style={{ fontWeight: 600 }}>{v.name}</td>
                  <td>
                    <span className={`type-pill type-${v.type.toLowerCase()}`}>{v.type}</span>
                  </td>
                  <td className="mono">{v.ip ?? '—'}</td>
                  <td
                    className="dim"
                    onClick={isAdmin && onRenameService ? (e) => e.stopPropagation() : undefined}
                  >
                    <ServiceCell
                      guest={v}
                      editable={!!(isAdmin && onRenameService)}
                      onRename={onRenameService}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="cell-bar">
                      <div className="bar">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${v.cpu_pct}%`,
                            background:
                              v.cpu_pct > 80 ? 'var(--err)' : v.cpu_pct > 60 ? 'var(--warn)' : 'var(--ok)',
                          }}
                        />
                      </div>
                      <span className="mono" style={{ fontSize: 12, width: 40, textAlign: 'right' }}>
                        {v.cpu_pct.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="cell-bar">
                      <div className="bar">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${ramBar}%`,
                            background: ramPct > 80 ? 'var(--err)' : ramPct > 60 ? 'var(--warn)' : 'var(--ok)',
                          }}
                        />
                      </div>
                      <span className="mono" style={{ fontSize: 12, width: 40, textAlign: 'right' }}>
                        {ramPct.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="mono dim" style={{ textAlign: 'right' }}>
                    {fmtUptime(v.uptime_s)}
                  </td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <div className="row-actions">
                      {isAdmin && onQuickAddService && (
                        <button
                          className="btn icon"
                          title="Als Service-Monitoring hinzufügen"
                          aria-label={`${v.name} als Service-Monitoring hinzufügen`}
                          onClick={() => onQuickAddService(v)}
                          type="button"
                        >
                          {ICONS.plus}
                        </button>
                      )}
                      <button
                        className="btn icon"
                        title="Logs"
                        aria-label={`Logs für ${v.name} anzeigen`}
                        onClick={() => onLogs(v)}
                        type="button"
                      >
                        {ICONS.logs}
                      </button>
                      <button
                        className="btn icon danger"
                        title="Neu starten"
                        aria-label={`${v.name} neu starten`}
                        onClick={() => onRestart(v)}
                        type="button"
                        disabled={!v.running}
                      >
                        {ICONS.restart}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Service-label cell — plain text, or an inline editor for admins. */
function ServiceCell({
  guest,
  editable,
  onRename,
}: {
  guest: Guest;
  editable: boolean;
  onRename?: (vmid: number, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editable) {
    return <>{guest.service ?? '—'}</>;
  }

  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (next !== (guest.service ?? '')) onRename?.(guest.id, next);
    };
    return (
      <input
        className="input svc-cell-input"
        value={draft}
        autoFocus
        placeholder="Service-Name…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="svc-cell-edit"
      title="Service-Namen bearbeiten"
      onClick={() => {
        setDraft(guest.service ?? '');
        setEditing(true);
      }}
    >
      <span>{guest.service ?? '—'}</span>
      {ICONS.edit}
    </button>
  );
}
