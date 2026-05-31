import type { Guest, HostStatus } from '../types';
import { Dot, ICONS, StackedBar, TrendBars, fmtBytes, fmtUptime, type StackedSegment } from './primitives';

interface Props {
  host: HostStatus | null;
  guests: Guest[];
  /** CPU trend samples (most recent last). Falls back to a flat line. */
  cpuTrend?: number[];
  /** Disk growth trend. */
  diskTrend?: number[];
}

// Stable peach→indigo→info palette for stacked-bar segments.
const SEG_COLORS = [
  '#ffb17a', '#5a608a', '#4f9eff', '#00d97e', '#ffd6b1',
  '#424769', '#7d83b3', '#3acf86', '#ff7a59', '#a8aed5',
];

function ramByGuest(guests: Guest[]): StackedSegment[] {
  const consumers = guests
    .filter((g) => g.ram_used_b > 0)
    .map((g) => ({ name: g.name, gb: g.ram_used_b / 1024 ** 3 }))
    .sort((a, b) => b.gb - a.gb);
  return consumers.map((c, i) => ({ ...c, color: SEG_COLORS[i % SEG_COLORS.length] }));
}

export function HostPanel({ host, guests, cpuTrend, diskTrend }: Props) {
  if (!host) {
    return (
      <section className="host-panel">
        <header className="host-panel-head">
          <div className="title-block">
            <h2>Proxmox Host</h2>
            <span className="badge"><Dot status="idle" /> WAITING</span>
          </div>
        </header>
        <div className="host-metric"><span className="dim">Initialisierung…</span></div>
      </section>
    );
  }
  const ramPct = host.ram_total_b > 0 ? (host.ram_used_b / host.ram_total_b) * 100 : 0;
  const diskPct = host.disk_total_b > 0 ? (host.disk_used_b / host.disk_total_b) * 100 : 0;
  const status = host.online ? 'ok' : 'err';
  const segments = ramByGuest(guests);
  // host_metrics samples every minute, so the chart needs at least ~3 real
  // samples before its shape is meaningful. Below that, show the current
  // value as a single bar instead of a faked flat line — easier to read as
  // "history collecting" than as a wall of identical bars.
  const hasRealCpuHistory = (cpuTrend?.length ?? 0) >= 3;
  const hasRealDiskHistory = (diskTrend?.length ?? 0) >= 3;
  const cpuData = hasRealCpuHistory ? (cpuTrend as number[]) : [host.cpu_pct];
  const diskData = hasRealDiskHistory ? (diskTrend as number[]) : [diskPct];
  const cpuMax = Math.max(...cpuData);
  const cpuAvg = cpuData.reduce((a, b) => a + b, 0) / cpuData.length;
  const disksLabel = host.disks.length === 0
    ? 'keine Disks'
    : `${host.disks.length} disks · ${host.disks.every((d) => d.health === 'PASSED') ? 'PASSED' : 'CHECK'}`;
  return (
    <section className="host-panel">
      <header className="host-panel-head">
        <div className="title-block">
          <h2>Proxmox Host</h2>
          <span className={`badge ${status}`}>
            <Dot status={status} /> {host.online ? 'ONLINE' : 'OFFLINE'}
          </span>
          {host.cpu_temp_c != null && (
            <span className="host-stat-inline">{ICONS.temp}<span className="mono">{host.cpu_temp_c}°C</span></span>
          )}
          <span className="host-stat-inline">{ICONS.disk}<span className="mono">{disksLabel}</span></span>
        </div>
        <span className="meta">
          {host.node}
          {host.pve_version && ` · PVE ${host.pve_version}`}
          {host.kernel && ` · ${host.kernel}`}
          {host.uptime_s > 0 && ` · up ${fmtUptime(host.uptime_s)}`}
        </span>
      </header>

      <div className="host-metric">
        <div className="host-metric-head">
          <span>CPU</span>
          <span className="mono dimmer">{hasRealCpuHistory ? 'last 48h' : 'sammle Daten…'}</span>
        </div>
        <div className="host-metric-value">
          {host.cpu_pct.toFixed(1)}<span className="pct">%</span>
          <span className="unit-sm">· {host.cpu_cores} cores</span>
        </div>
        <span className="host-metric-sub">
          {hasRealCpuHistory
            ? `avg ${Math.round(cpuAvg)}% · peak ${Math.round(cpuMax)}%`
            : `${(cpuTrend?.length ?? 0)}/3 Samples · 1/min`}
        </span>
        <TrendBars data={cpuData} color="var(--accent)" threshold={cpuMax * 0.85} />
      </div>

      <div className="host-metric">
        <div className="host-metric-head"><span>RAM</span><span className="mono dimmer">by guest</span></div>
        <div className="host-metric-value">
          {(host.ram_used_b / 1024 ** 3).toFixed(1)}<span className="unit-sm">/ {(host.ram_total_b / 1024 ** 3).toFixed(1)} GB</span>
          <span className="pct">· {Math.round(ramPct)}%</span>
        </div>
        <span className="host-metric-sub">{segments.length} consumers · {fmtBytes(host.ram_used_b)} used</span>
        <StackedBar segments={segments} />
        <div className="stacked-legend">
          {segments.slice(0, 5).map((s) => (
            <span key={s.name} className="item">
              <span className="swatch-sm" style={{ background: s.color }} />
              {s.name}
              <span className="item-val">{s.gb.toFixed(1)} GB</span>
            </span>
          ))}
        </div>
      </div>

      <div className="host-metric">
        <div className="host-metric-head">
          <span>Disk · rpool</span>
          <span className="mono dimmer">{hasRealDiskHistory ? 'usage' : 'sammle Daten…'}</span>
        </div>
        <div className="host-metric-value">
          {(host.disk_used_b / 1024 ** 3).toFixed(1)}<span className="unit-sm">/ {(host.disk_total_b / 1024 ** 3).toFixed(1)} GB</span>
          <span className="pct">· {Math.round(diskPct)}%</span>
        </div>
        <span className="host-metric-sub">{fmtBytes(host.disk_total_b - host.disk_used_b)} frei</span>
        <TrendBars data={diskData} color="var(--ok)" />
      </div>
    </section>
  );
}
