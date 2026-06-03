import type { Guest, HostStatus } from '../types';
import { Dot, ICONS, fmtUptime } from './primitives';

interface Props {
  host: HostStatus | null;
  guests: Guest[];
}

function severity(pct: number): 'ok' | 'warn' | 'err' {
  if (pct >= 90) return 'err';
  if (pct >= 75) return 'warn';
  return 'ok';
}

export function HostPanel({ host }: Props) {
  if (!host) {
    return (
      <section className="host-panel">
        <header className="host-panel-head">
          <div className="title-block">
            <span className="eyebrow">Proxmox Host</span>
            <span className="badge"><Dot status="idle" /> WAITING</span>
          </div>
        </header>
        <div className="row-value dim">Initialisierung…</div>
      </section>
    );
  }

  const ramPct = host.ram_total_b > 0 ? (host.ram_used_b / host.ram_total_b) * 100 : 0;
  const diskPct = host.disk_total_b > 0 ? (host.disk_used_b / host.disk_total_b) * 100 : 0;
  const cpuPct = host.cpu_pct;
  const status = host.online ? 'ok' : 'err';

  const cpuSev = severity(cpuPct);
  const ramSev = severity(ramPct);
  const diskSev = severity(diskPct);

  const ramUsedGb = host.ram_used_b / 1024 ** 3;
  const ramTotalGb = host.ram_total_b / 1024 ** 3;
  const diskUsedGb = host.disk_used_b / 1024 ** 3;
  const diskTotalGb = host.disk_total_b / 1024 ** 3;

  return (
    <section className="host-panel">
      <header className="host-panel-head">
        <div className="title-block">
          <span className="eyebrow">Proxmox Host</span>
          <span className="host-name">{host.node}</span>
        </div>
        <span className={`badge ${status}`}>
          <Dot status={status} /> {host.online ? 'ONLINE' : 'OFFLINE'}
        </span>
      </header>

      <div className="host-row">
        <span className="row-label">{ICONS.cpu}CPU</span>
        <span className="row-value">
          <span className="val-strong">{cpuPct.toFixed(0)}%</span>
          <span className="val-sub"> · {host.cpu_cores} Cores</span>
        </span>
        <span className="row-bar">
          <span className={`fill ${cpuSev}`} style={{ width: `${Math.min(100, cpuPct)}%` }} />
        </span>
      </div>

      <div className="host-row">
        <span className="row-label">{ICONS.ram}RAM</span>
        <span className="row-value">
          <span className="val-strong">{ramUsedGb.toFixed(1)}</span>
          <span className="val-sub"> / {ramTotalGb.toFixed(1)} GB</span>
        </span>
        <span className="row-bar">
          <span className={`fill ${ramSev}`} style={{ width: `${Math.min(100, ramPct)}%` }} />
        </span>
      </div>

      <div className="host-row">
        <span className="row-label">{ICONS.disk}Disk</span>
        <span className="row-value">
          <span className="val-strong">{diskUsedGb.toFixed(1)}</span>
          <span className="val-sub"> / {diskTotalGb.toFixed(1)} GB</span>
        </span>
        <span className="row-bar">
          <span className={`fill ${diskSev}`} style={{ width: `${Math.min(100, diskPct)}%` }} />
        </span>
      </div>

      <footer className="host-panel-foot">
        <span>
          {host.pve_version ? `PVE ${host.pve_version}` : host.kernel || ''}
          {host.cpu_temp_c != null && (host.pve_version || host.kernel) ? ' · ' : ''}
          {host.cpu_temp_c != null ? `${host.cpu_temp_c}°C` : ''}
        </span>
        <span>{host.uptime_s > 0 ? `up ${fmtUptime(host.uptime_s)}` : ''}</span>
      </footer>
    </section>
  );
}
