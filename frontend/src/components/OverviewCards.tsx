import type { BackupSummary, Guest, HostStatus, TunnelStatus } from '../types';
import { Donut, Dot, Num, fmtBytes, fmtTimeAgo, fmtUptime } from './primitives';

interface Props {
  host: HostStatus | null;
  guests: Guest[];
  tunnel: TunnelStatus | null;
  backups: BackupSummary | null;
  loading?: boolean;
}

export function OverviewCards({ host, guests, tunnel, backups, loading }: Props) {
  const initialLoad = loading && !host && !tunnel && !backups && guests.length === 0;
  if (initialLoad) {
    return (
      <div className="overview-grid" aria-busy="true" aria-label="Übersicht lädt">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card overview-card skeleton-card" aria-hidden="true">
            <div className="skeleton skeleton-h" />
            <div className="skeleton skeleton-body" />
            <div className="skeleton skeleton-line" />
          </div>
        ))}
      </div>
    );
  }

  const upCount = guests.filter((v) => v.running).length;
  const ramPct = host && host.ram_total_b ? (host.ram_used_b / host.ram_total_b) * 100 : 0;
  const diskPct = host && host.disk_total_b ? (host.disk_used_b / host.disk_total_b) * 100 : 0;

  const tunnelStatus = tunnel?.status ?? 'unknown';
  const tunnelBadgeClass =
    tunnelStatus === 'healthy' ? 'ok' : tunnelStatus === 'unknown' ? 'warn' : 'err';

  const dsPct = backups?.datastore?.used_pct ?? 0;
  const dsFreeB = backups?.datastore ? backups.datastore.total_b - backups.datastore.used_b : 0;

  return (
    <div className="overview-grid">
      {/* Proxmox Host */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Proxmox Host</h3>
          <span className={`badge ${host?.online ? 'ok' : 'err'}`}>
            <span className={`dot ${host?.online ? 'ok' : 'err'}`} /> {host?.online ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
        <div className="ov-body">
          <Donut value={host?.cpu_pct ?? 0} label="CPU" sublabel={host ? `${host.cpu_cores} Cores` : ''} />
          <Donut
            value={ramPct}
            label="RAM"
            sublabel={host ? `${fmtBytes(host.ram_used_b)} / ${fmtBytes(host.ram_total_b)}` : ''}
          />
          <Donut
            value={diskPct}
            label="DISK"
            sublabel={host ? `${fmtBytes(host.disk_used_b)} / ${fmtBytes(host.disk_total_b)}` : ''}
          />
        </div>
        <div className="ov-foot mono">
          {host?.node ?? '—'} · {host?.pve_version ?? '—'} · kernel {host?.kernel ?? '—'}
        </div>
      </div>

      {/* Containers/VMs */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Container & VMs</h3>
          <span className="badge ok">
            <Num value={`${upCount}/${guests.length}`} size="sm" /> RUNNING
          </span>
        </div>
        <div className="ov-big">
          <Num value={upCount} size="xl" />
          <span className="dim" style={{ fontSize: 13 }}>
            von {guests.length} laufen
          </span>
        </div>
        <div className="ov-mini-list">
          {guests.slice(0, 4).map((v) => (
            <div key={v.id} className="mini-row">
              <Dot status={v.status} />
              <span className="mono dim" style={{ fontSize: 11 }}>
                {v.id}
              </span>
              <span style={{ fontSize: 12 }}>{v.name}</span>
              <span className="mono dimmer" style={{ fontSize: 11, marginLeft: 'auto' }}>
                {fmtUptime(v.uptime_s)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Cloudflare Tunnel */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Cloudflare Tunnel</h3>
          <span className={`badge ${tunnelBadgeClass}`}>
            <span className={`dot ${tunnelBadgeClass}`} /> {tunnelStatus.toUpperCase()}
          </span>
        </div>
        <div className="ov-rows">
          <div className="ov-row">
            <span className="dim">Connections</span>
            <Num value={tunnel?.connections ?? 0} unit="active" size="md" />
          </div>
          <div className="ov-row">
            <span className="dim">Region</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {tunnel?.regions?.join(' · ') || '—'}
            </span>
          </div>
          <div className="ov-row">
            <span className="dim">WAN-IP</span>
            <span className="mono" style={{ fontSize: 13, color: 'var(--text-1)' }}>
              {tunnel?.wan_ip ?? '—'}
            </span>
          </div>
          <div className="ov-row">
            <span className="dim">cloudflared</span>
            <span className="mono dim" style={{ fontSize: 12 }}>
              {tunnel?.cloudflared_version ?? '—'}
            </span>
          </div>
        </div>
      </div>

      {/* Backup */}
      <div className="card overview-card">
        <div className="card-h">
          <h3>Backup (PBS)</h3>
          <BackupBadge backups={backups} />
        </div>
        {backups && backups.reachable === false ? (
          <div className="ov-empty" role="status">
            <span className="dot err" aria-hidden="true" />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>PBS nicht erreichbar</div>
              <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
                {backups.error ?? 'Token oder Netzwerk prüfen'}
              </div>
            </div>
          </div>
        ) : (
          <div className="ov-rows">
            <div className="ov-row">
              <span className="dim">Letzter Erfolg</span>
              <span className="mono" style={{ fontSize: 13 }}>
                {fmtTimeAgo(backups?.last_success_iso ?? null)}
              </span>
            </div>
            <div className="ov-row">
              <span className="dim">Datastore</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
                <div
                  className="bar"
                  role="progressbar"
                  aria-valuenow={dsPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Datastore Auslastung"
                >
                  <div
                    className="bar-fill"
                    style={{
                      width: `${dsPct}%`,
                      background: dsPct > 85 ? 'var(--err)' : dsPct > 70 ? 'var(--warn)' : 'var(--ok)',
                    }}
                  />
                </div>
                <span className="mono" style={{ fontSize: 12 }}>
                  {dsPct}%
                </span>
              </div>
            </div>
            <div className="ov-row">
              <span className="dim">Frei</span>
              <Num value={fmtBytes(dsFreeB)} size="md" />
            </div>
            <div className="ov-row">
              <span className="dim">Name</span>
              <span className="mono dim" style={{ fontSize: 12 }}>
                {backups?.datastore?.name ?? '—'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BackupBadge({ backups }: { backups: BackupSummary | null }) {
  if (!backups) {
    return (
      <span className="badge" aria-label="Backup-Status lädt">
        <span className="dot" aria-hidden="true" /> — / —
      </span>
    );
  }
  if (backups.reachable === false) {
    return (
      <span className="badge err" aria-label="Backup-Server nicht erreichbar">
        <span className="dot err" aria-hidden="true" /> OFFLINE
      </span>
    );
  }
  const success = backups.success_today;
  const total = backups.total_today;
  const cls = total === 0 ? 'warn' : success === total ? 'ok' : success > 0 ? 'warn' : 'err';
  const label = total === 0 ? 'Heute keine Jobs' : `${success} von ${total} Jobs erfolgreich`;
  return (
    <span className={`badge ${cls}`} aria-label={label}>
      <span className={`dot ${cls}`} aria-hidden="true" />
      {success}/{total} HEUTE
    </span>
  );
}
