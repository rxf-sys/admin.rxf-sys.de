/**
 * Three-card host overview for the Server tab, matching the mockup layout:
 *
 *   ┌─Proxmox Host (rings)─┬─RAM nach Gast─┬─Datenträger (SMART)─┐
 *
 * Lives next to the existing one-card HostPanel which still drives the
 * Overview tab — same data shape, different visual density.
 */
import type { Guest, HostStatus } from '../types';
import { Dot, ICONS, fmtBytes, fmtUptime } from './primitives';

const GUEST_PALETTE = [
  '#ff4757', '#ffb17a', '#ffd6b1', '#4f9eff', '#7ab6ff', '#5a608a', '#00d97e', '#e056a8',
];

interface HostGridProps {
  host: HostStatus | null;
  guests: Guest[];
}

export function HostGrid({ host, guests }: HostGridProps) {
  return (
    <div className="grid-12" style={{ marginBottom: 16 }}>
      <HostRingsCard host={host} />
      <RamByGuestCard host={host} guests={guests} />
      <DisksCard host={host} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ring component — reused for CPU/RAM/Disk in the host card.
// ---------------------------------------------------------------------------

function Ring({
  pct,
  size = 88,
  stroke = 8,
  color,
  centerLabel,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color: string;
  centerLabel?: string;
}) {
  const clamped = Math.max(0, Math.min(pct, 100));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
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
      {centerLabel && (
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={size * 0.24}
          fontWeight={700}
          fill="var(--text-1)"
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}

function ringColor(pct: number): string {
  if (pct > 85) return 'var(--err)';
  if (pct > 70) return 'var(--warn)';
  return 'var(--ok)';
}

// ---------------------------------------------------------------------------
// Card 1 · Proxmox Host with CPU/RAM/Disk rings
// ---------------------------------------------------------------------------

function HostRingsCard({ host }: { host: HostStatus | null }) {
  if (!host) {
    return (
      <div className="card col-4">
        <div className="card-h">
          <h3>Proxmox Host</h3>
          <span className="badge"><Dot status="idle" /> WAITING</span>
        </div>
        <div className="dim" style={{ fontSize: 12 }}>Initialisierung…</div>
      </div>
    );
  }
  const ramPct = host.ram_total_b > 0 ? (host.ram_used_b / host.ram_total_b) * 100 : 0;
  const diskPct = host.disk_total_b > 0 ? (host.disk_used_b / host.disk_total_b) * 100 : 0;
  const cpuPct = host.cpu_pct;
  const statusTone = host.online ? 'ok' : 'err';
  const tempLabel = host.cpu_temp_c != null ? `· ${host.cpu_temp_c}°C` : '';
  return (
    <div className="card col-4 host-rings-card">
      <div className="card-h">
        <h3>Proxmox Host {host.node && <span className="h3-sub">· {host.node} · PVE {host.pve_version ?? ''}</span>}</h3>
        <span className={`badge ${statusTone}`}>
          <Dot status={statusTone} /> {host.online ? 'ONLINE' : 'OFFLINE'} {tempLabel}
        </span>
      </div>
      <div className="host-rings">
        <RingTile label="CPU" sub={`${host.cpu_cores} Cores`} pct={cpuPct} />
        <RingTile label="RAM" sub={`${(host.ram_used_b / 1024 ** 3).toFixed(1)} / ${(host.ram_total_b / 1024 ** 3).toFixed(1)} GB`} pct={ramPct} />
        <RingTile label="DISK" sub={`${(host.disk_used_b / 1024 ** 3).toFixed(1)} / ${(host.disk_total_b / 1024 ** 3).toFixed(1)} GB`} pct={diskPct} />
      </div>
      <div className="host-foot dimmer mono">
        <span>{host.kernel ?? '—'}</span>
        <span>uptime {fmtUptime(host.uptime_s)}</span>
      </div>
    </div>
  );
}

function RingTile({ label, sub, pct }: { label: string; sub: string; pct: number }) {
  return (
    <div className="ring-tile">
      <Ring pct={pct} color={ringColor(pct)} centerLabel={`${Math.round(pct)}`} />
      <div className="ring-meta">
        <span className="ring-label">{label}</span>
        <span className="ring-sub">{sub}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 2 · RAM nach Gast — stacked bar + per-guest list
// ---------------------------------------------------------------------------

function RamByGuestCard({ host, guests }: { host: HostStatus | null; guests: Guest[] }) {
  const usedTotal = host?.ram_used_b ?? 0;
  const consumers = guests
    .filter((g) => g.ram_used_b > 0)
    .sort((a, b) => b.ram_used_b - a.ram_used_b);
  const top = consumers.slice(0, 5);
  const rest = consumers.slice(5);
  const restBytes = rest.reduce((s, g) => s + g.ram_used_b, 0);
  const list = [
    ...top.map((g, i) => ({ name: g.name, bytes: g.ram_used_b, color: GUEST_PALETTE[i % GUEST_PALETTE.length] })),
    ...(rest.length > 0 ? [{ name: `andere (${rest.length})`, bytes: restBytes, color: '#5a608a' }] : []),
  ];
  const maxRow = list.reduce((m, it) => Math.max(m, it.bytes), 0) || 1;

  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>RAM nach Gast</h3>
        <span className="dimmer mono" style={{ fontSize: 11 }}>{fmtBytes(usedTotal)} belegt</span>
      </div>
      {consumers.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>Keine laufenden Gäste mit RAM-Daten.</div>
      ) : (
        <>
          <div className="ram-stacked-bar" role="img" aria-label="RAM-Verteilung pro Gast">
            {list.map((it) => (
              <span
                key={it.name}
                style={{
                  background: it.color,
                  flex: Math.max(1, (it.bytes / Math.max(1, usedTotal)) * 100),
                }}
                title={`${it.name} · ${fmtBytes(it.bytes)}`}
              />
            ))}
          </div>
          <div className="guest-size-list" style={{ marginTop: 12 }}>
            {list.map((it) => {
              const w = Math.max(3, (it.bytes / maxRow) * 100);
              return (
                <div key={it.name} className="guest-size-row">
                  <span className="dot-color" style={{ background: it.color }} />
                  <span className="guest-size-name">{it.name}</span>
                  <span className="guest-size-bar"><span style={{ width: `${w}%`, background: it.color }} /></span>
                  <span className="guest-size-val mono">{(it.bytes / 1024 ** 3).toFixed(1)} GB</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 3 · Datenträger / SMART
// ---------------------------------------------------------------------------

function DisksCard({ host }: { host: HostStatus | null }) {
  const disks = host?.disks ?? [];
  const subtitle = disks.length === 0 ? '' : 'SMART';
  const poolLabel = disks.length >= 2 && disks.every((d) => d.health === 'PASSED')
    ? 'rpool · ZFS mirror'
    : disks.length === 1
      ? 'single disk'
      : '—';

  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>Datenträger {subtitle && <span className="h3-sub">· {subtitle}</span>}</h3>
      </div>
      {disks.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>Keine SMART-Daten verfügbar.</div>
      ) : (
        <>
          <div className="disks-list">
            {disks.map((d) => {
              const tone = d.health === 'PASSED' ? 'ok' : d.health === 'FAILED' ? 'err' : 'warn';
              return (
                <div key={d.device} className="disk-row">
                  <span className="disk-ico">{ICONS.disk}</span>
                  <div className="disk-body">
                    <div className="disk-device mono">{d.device}</div>
                    <div className="dimmer mono" style={{ fontSize: 10.5 }}>
                      {fmtBytes(d.size_b)}{d.temp_c != null && ` · ${d.temp_c}°C`}
                    </div>
                  </div>
                  <span className={`badge ${tone}`}>{d.health}</span>
                </div>
              );
            })}
          </div>
          <div className="host-foot" style={{ marginTop: 'auto' }}>
            <span className="dimmer">Pool</span>
            <span className="mono">{poolLabel}</span>
          </div>
        </>
      )}
    </div>
  );
}
