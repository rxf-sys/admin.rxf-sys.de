import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { NetworkSnapshot, NetworkThroughput, TunnelStatus, UnifiDevice } from '../types';
import { AreaChart, Dot, ICONS, Num, fmtUptime } from './primitives';

interface Props {
  network: NetworkSnapshot | null;
  tunnel: TunnelStatus | null;
  /** Poll interval in ms; 0 pauses (mirrors the global pause switch). */
  pollMs: number;
}

// Stable swatch palette for VLAN rows.
const VLAN_COLORS = ['#4f9eff', '#00d97e', '#ffb020', '#8a8f9d', '#ffb17a', '#9b59ff'];

export function NetworkPanel({ network, tunnel, pollMs }: Props) {
  const throughput = usePoll((sig) => api.networkThroughput(1, sig), pollMs).data;

  const errored = network && network.reachable === false;
  const devices = network?.devices ?? [];
  const vlans = network?.networks ?? [];
  const totalClients = vlans.reduce((a, v) => a + v.clients, 0);
  const publicIp = tunnel?.wan_ip ?? network?.wan_ip ?? null;
  const linkStr =
    network?.link_down_mbit && network?.link_up_mbit
      ? `${Math.round(network.link_down_mbit)} / ${Math.round(network.link_up_mbit)}`
      : null;
  const gatewayIp = devices.find((d) => d.is_gateway)?.ip ?? null;

  if (errored) {
    return (
      <section className="network-section" aria-labelledby="network-heading">
        <div className="dash-section-head" style={{ marginBottom: 12 }}>
          <h2 id="network-heading">Netzwerk</h2>
        </div>
        <div className="grid-12">
          <div className="col-12 card">
            <div className="card-h">
              <h3>UniFi unerreichbar</h3>
              <span className="badge err"><Dot status="err" /> ERROR</span>
            </div>
            <div className="dim" style={{ fontSize: 13 }}>{network?.error ?? 'Konfiguration prüfen.'}</div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="network-section" aria-labelledby="network-heading">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2 id="network-heading">Netzwerk</h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>
            {network?.auth_mode === 'api-key'
              ? 'UniFi Integration API'
              : network?.auth_mode === 'cookie'
                ? 'UniFi (Legacy)'
                : 'kein UniFi'}
          </span>
        </div>
      </div>

      <div className="grid-12" style={{ marginBottom: 16 }}>
        {/* WAN · DDNS */}
        <div className="card col-4">
          <div className="card-h">
            <h3>WAN · DDNS</h3>
            <span className={`badge ${publicIp ? 'ok' : 'warn'}`}>
              <Dot status={publicIp ? 'ok' : 'warn'} /> {publicIp ? 'SYNC' : 'KEINE IP'}
            </span>
          </div>
          <div className="kv-stack">
            <div className="kv-row"><span className="kv-k">Public IP</span><span className="kv-v mono">{publicIp ?? '—'}</span></div>
            <div className="kv-row"><span className="kv-k">ISP</span><span className="kv-v">{network?.isp ?? '—'}</span></div>
            <div className="kv-row">
              <span className="kv-k">Link</span>
              {linkStr ? <Num value={linkStr} unit="Mbit" size="md" /> : <span className="kv-v mono">—</span>}
            </div>
            <div className="kv-row"><span className="kv-k">Gateway</span><span className="kv-v mono">{gatewayIp ?? '—'}</span></div>
          </div>
        </div>

        {/* WAN Throughput */}
        <div className="card col-8">
          <ThroughputChart
            throughput={throughput}
            liveDown={network?.throughput_down_mbit ?? 0}
            liveUp={network?.throughput_up_mbit ?? 0}
            authMode={network?.auth_mode ?? 'none'}
          />
        </div>
      </div>

      {devices.length > 0 && (
        <>
          <div className="dash-section-head">
            <h2>UniFi Devices <span className="count">· {devices.length} online</span></h2>
          </div>
          <div className="grid-12" style={{ marginBottom: 16 }}>
            {devices.map((d) => (
              <div key={d.id} className="card device-card col-6">
                <DeviceCard device={d} />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="grid-12">
        <div className="card col-12">
          <div className="card-h">
            <h3>VLANs <span className="h3-sub">· {totalClients} Clients total</span></h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>{vlans.length} Netze</span>
          </div>
          {vlans.length === 0 ? (
            <div className="dim" style={{ fontSize: 12 }}>Keine VLANs konfiguriert.</div>
          ) : (
            <div className="vlan-list">
              {vlans.map((v, i) => {
                const color = VLAN_COLORS[i % VLAN_COLORS.length];
                const pct = totalClients > 0 ? (v.clients / totalClients) * 100 : 0;
                return (
                  <div key={`${v.name}-${v.vlan ?? i}`} className="vlan-row">
                    <span className="vlan-swatch" style={{ background: color }} />
                    <span className="vlan-name">{v.name}</span>
                    <span className="mono dimmer" style={{ fontSize: 11 }}>
                      VLAN {v.vlan ?? '—'}
                    </span>
                    <div className="vlan-bar">
                      <div style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 600, width: 28, textAlign: 'right' }}>
                      {v.clients}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ThroughputChart({
  throughput,
  liveDown,
  liveUp,
  authMode,
}: {
  throughput: NetworkThroughput | null;
  liveDown: number;
  liveUp: number;
  authMode: string;
}) {
  const samples = throughput?.samples ?? [];
  const downs = samples.map((s) => s.down_mbit);
  const ups = samples.map((s) => s.up_mbit);
  const noHistory = samples.length < 2;
  const apiKeyNoThroughput = authMode === 'api-key' && liveDown === 0 && liveUp === 0;
  const curDown = downs.length ? downs[downs.length - 1] : liveDown;
  const curUp = ups.length ? ups[ups.length - 1] : liveUp;

  return (
    <>
      <div className="card-h">
        <h3>WAN Throughput <span className="h3-sub">letzte 60 min · 1 min Auflösung</span></h3>
        <div className="throughput-legend">
          <span className="item">
            <span className="dash" style={{ background: 'var(--info)' }} />
            <span className="dim">DOWN</span>
            <span className="mono" style={{ color: 'var(--text-1)' }}>{curDown.toFixed(1)}</span>
            <span className="dimmer">Mbit/s</span>
          </span>
          <span className="item">
            <span className="dash" style={{ background: 'var(--accent)' }} />
            <span className="dim">UP</span>
            <span className="mono" style={{ color: 'var(--text-1)' }}>{curUp.toFixed(1)}</span>
            <span className="dimmer">Mbit/s</span>
          </span>
        </div>
      </div>
      {apiKeyNoThroughput ? (
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.55, padding: '20px 0' }}>
          Die UniFi Integration API liefert keinen Live-Durchsatz — nur die Legacy-Cookie-Auth tut das.
          Daher kein Verlaufs-Chart.
        </div>
      ) : noHistory ? (
        <div className="dim" style={{ fontSize: 12, padding: '20px 0' }}>
          Sammle Verlauf — Sampling-Loop läuft alle 60 s.
        </div>
      ) : (
        <>
          <AreaChart series={downs} secondary={ups} color="var(--info)" secondaryColor="var(--accent)" height={140} />
          <div className="throughput-foot">
            <span>peak ↓ {throughput?.peak_down_mbit ?? 0} Mbit · ↑ {throughput?.peak_up_mbit ?? 0} Mbit</span>
            <span>−60 min<span style={{ margin: '0 20px' }}>−30 min</span>jetzt</span>
          </div>
        </>
      )}
    </>
  );
}

function DeviceCard({ device }: { device: UnifiDevice }) {
  const status = device.state === 'ONLINE' ? 'ok' : device.state === 'OFFLINE' ? 'err' : 'warn';
  const role = device.is_gateway ? 'Router · GW' : 'Access Point';
  return (
    <>
      <div className="device-head">
        <span className="device-icon" aria-hidden="true">
          {device.is_gateway ? ICONS.router : ICONS.wifi}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{device.name}</span>
            <span className={`badge ${status}`}><Dot status={status} /> {device.state}</span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            <span className="mono">{device.model ?? '—'}</span> · {role}
            {device.ip && <> · <span className="mono">{device.ip}</span></>}
          </span>
        </div>
        {device.uptime_s > 0 && (
          <span className="mono dimmer" style={{ fontSize: 11 }}>up {fmtUptime(device.uptime_s)}</span>
        )}
      </div>
      <div className="device-metrics">
        <div className="dev-metric">
          <span className="dev-metric-label">CPU</span>
          <div className="cell-bar" style={{ justifyContent: 'flex-start' }}>
            <div className="bar" style={{ flex: 1 }}>
              <div className="bar-fill" style={{ width: `${device.cpu_pct ?? 0}%`, background: 'var(--accent)' }} />
            </div>
            <span className="mono" style={{ fontSize: 11.5, width: 36, textAlign: 'right' }}>
              {device.cpu_pct == null ? '—' : `${Math.round(device.cpu_pct)}%`}
            </span>
          </div>
        </div>
        <div className="dev-metric">
          <span className="dev-metric-label">RAM</span>
          <div className="cell-bar" style={{ justifyContent: 'flex-start' }}>
            <div className="bar" style={{ flex: 1 }}>
              <div className="bar-fill" style={{ width: `${device.mem_pct ?? 0}%`, background: 'var(--accent)' }} />
            </div>
            <span className="mono" style={{ fontSize: 11.5, width: 36, textAlign: 'right' }}>
              {device.mem_pct == null ? '—' : `${Math.round(device.mem_pct)}%`}
            </span>
          </div>
        </div>
        {device.is_gateway && device.ports_total != null && device.ports_total > 0 ? (
          <div className="dev-metric">
            <span className="dev-metric-label">Ports</span>
            <div className="port-grid">
              {Array.from({ length: device.ports_total }).map((_, i) => (
                <span key={i} className={`port ${i < (device.ports_used ?? 0) ? 'on' : ''}`} />
              ))}
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 8 }}>
                {device.ports_used ?? 0}/{device.ports_total}
              </span>
            </div>
          </div>
        ) : (
          <div className="dev-metric">
            <span className="dev-metric-label">Clients</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{device.clients}</span>
              <span className="dimmer" style={{ fontSize: 11 }}>verbunden</span>
            </span>
          </div>
        )}
      </div>
    </>
  );
}
