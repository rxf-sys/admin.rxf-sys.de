import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { IspMetrics, NetworkSnapshot, NetworkThroughput, TunnelStatus, UnifiDevice } from '../types';
import { Dot, ICONS, Sparkline, fmtUptime } from './primitives';

interface Props {
  network: NetworkSnapshot | null;
  tunnel: TunnelStatus | null;
  /** Poll interval in ms; 0 pauses (mirrors the global pause switch). */
  pollMs: number;
}

export function NetworkPanel({ network, tunnel, pollMs }: Props) {
  const throughput = usePoll((sig) => api.networkThroughput(1, sig), pollMs).data;

  const errored = network && network.reachable === false;
  const devices = network?.devices ?? [];
  const vlans = network?.networks ?? [];
  const publicIp = tunnel?.wan_ip ?? network?.wan_ip ?? null;
  // UniFi's Integration API reports the gateway device's `ipAddress` as
  // the WAN-side IP on UCG/UDM — that's the public address, not the LAN
  // gateway. Suppress it when it matches publicIp so we don't relabel the
  // WAN as 'Gateway'.
  const rawGatewayIp = devices.find((d) => d.is_gateway)?.ip ?? null;
  const gatewayIp = rawGatewayIp && rawGatewayIp !== publicIp ? rawGatewayIp : null;
  const ispMetrics = network?.isp_metrics ?? null;

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

  const gatewayDevice = devices.find((d) => d.is_gateway);
  const gatewayModel = gatewayDevice?.model;
  const sourceBadge = ispMetrics
    ? `UniFi · Integration + Site Manager${ispMetrics.host_name ? ` (${ispMetrics.host_name})` : ''}`
    : gatewayModel
      ? `UniFi · ${gatewayModel}`
      : network?.auth_mode === 'api-key'
        ? 'UniFi Integration API'
        : network?.auth_mode === 'cookie'
          ? 'UniFi (Legacy)'
          : 'kein UniFi';

  return (
    <section className="network-section" aria-labelledby="network-heading">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2 id="network-heading">Netzwerk</h2>
        <span className="dimmer mono" style={{ fontSize: 11 }}>{sourceBadge}</span>
      </div>

      {/* Top row: WAN · ISP/Throughput · Clients-Split */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <WanCard
          publicIp={publicIp}
          ispName={network?.isp ?? null}
          gatewayIp={gatewayIp}
          linkDown={network?.link_down_mbit ?? null}
          linkUp={network?.link_up_mbit ?? null}
        />
        <ThroughputCard
          throughput={throughput}
          liveDown={network?.throughput_down_mbit ?? 0}
          liveUp={network?.throughput_up_mbit ?? 0}
          ispMetrics={ispMetrics}
          authMode={network?.auth_mode ?? 'none'}
        />
        <ClientsCard
          total={network?.clients_total ?? 0}
          wired={network?.clients_wired ?? 0}
          wireless={network?.clients_wireless ?? 0}
          vlans={vlans}
        />
      </div>

      {ispMetrics && <IspQualityCard metrics={ispMetrics} />}

      {devices.length > 0 && (
        <>
          <div className="dash-section-head">
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Geräte &amp; Verbindungen</h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>{devices.length} online</span>
          </div>
          <div className="grid-12">
            {devices.map((d) => (
              <div key={d.id} className="card device-card col-6">
                <DeviceCard device={d} />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function WanCard({
  publicIp,
  ispName,
  gatewayIp,
  linkDown,
  linkUp,
}: {
  publicIp: string | null;
  ispName: string | null;
  gatewayIp: string | null;
  linkDown: number | null;
  linkUp: number | null;
}) {
  const linkStr = linkDown && linkUp ? `${Math.round(linkDown)} / ${Math.round(linkUp)} Mbit` : null;
  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>WAN &amp; DDNS</h3>
        <span className={`badge ${publicIp ? 'ok' : 'warn'}`}>
          <Dot status={publicIp ? 'ok' : 'warn'} /> {publicIp ? 'SYNC' : 'KEINE IP'}
        </span>
      </div>
      <div className="kv-stack">
        <div className="kv-row">
          <span className="kv-k">Public IP</span>
          <span className="kv-v mono">{publicIp ?? '—'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-k">ISP</span>
          <span className="kv-v">{ispName ?? '—'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-k">Link</span>
          <span className="kv-v mono">{linkStr ?? '—'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-k">Gateway</span>
          <span className="kv-v mono">{gatewayIp ?? '—'}</span>
        </div>
      </div>
    </div>
  );
}

function ClientsCard({
  total,
  wired,
  wireless,
  vlans,
}: {
  total: number;
  wired: number;
  wireless: number;
  vlans: { name: string; vlan: number | null }[];
}) {
  const split = total > 0 ? { wired: (wired / total) * 100, wireless: (wireless / total) * 100 } : { wired: 0, wireless: 0 };
  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>Clients</h3>
        <span className="dimmer mono" style={{ fontSize: 11 }}>{total} verbunden</span>
      </div>
      <div className="client-split-row">
        <div className="client-split-tile">
          <span className="client-split-label">Wired</span>
          <span className="client-split-value mono">{wired}</span>
        </div>
        <div className="client-split-tile">
          <span className="client-split-label">Wireless</span>
          <span className="client-split-value mono">{wireless}</span>
        </div>
      </div>
      {total > 0 && (
        <div className="client-split-bar" aria-hidden="true">
          <span className="seg wired" style={{ width: `${split.wired}%` }} />
          <span className="seg wireless" style={{ width: `${split.wireless}%` }} />
        </div>
      )}
      {vlans.length > 0 && (
        <div className="vlan-chips">
          {vlans.map((v) => (
            <span key={`${v.name}-${v.vlan ?? '_'}`} className="vlan-chip">
              <span className="vlan-chip-name">{v.name}</span>
              {v.vlan != null && <span className="vlan-chip-id mono">VLAN {v.vlan}</span>}
            </span>
          ))}
        </div>
      )}
      <p className="dim" style={{ fontSize: 10.5, margin: '6px 0 0', lineHeight: 1.5 }}>
        VLAN-Zuordnung pro Client wird von der Integration API nicht
        veröffentlicht — Verteilung daher nach Anschlussart.
      </p>
    </div>
  );
}

function ThroughputCard({
  throughput,
  liveDown,
  liveUp,
  ispMetrics,
  authMode,
}: {
  throughput: NetworkThroughput | null;
  liveDown: number;
  liveUp: number;
  ispMetrics: IspMetrics | null;
  authMode: string;
}) {
  const samples = throughput?.samples ?? [];
  const downs = samples.map((s) => s.down_mbit);
  const ups = samples.map((s) => s.up_mbit);
  const noHistory = samples.length < 2;
  const curDown = downs.length ? downs[downs.length - 1] : liveDown;
  const curUp = ups.length ? ups[ups.length - 1] : liveUp;
  // Without legacy auth or Site Manager metrics, the live values are 0 —
  // tell the user explicitly instead of showing a misleading "0.0 Mbit/s".
  const noLiveData = curDown === 0 && curUp === 0 && !ispMetrics;
  const sourceLabel = ispMetrics
    ? 'live · Site Manager'
    : authMode === 'cookie'
      ? 'live'
      : 'snapshot';

  return (
    <div className="card col-4">
      <div className="card-h">
        <h3>Durchsatz <span className="h3-sub">{sourceLabel}</span></h3>
      </div>
      {noLiveData ? (
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Integration API liefert keinen Live-Durchsatz. Site-Manager-API-Key
          unter <strong>Einstellungen → UniFi</strong> hinterlegen für ISM-Daten.
        </div>
      ) : (
        <div className="throughput-pair">
          <div className="throughput-tile">
            <div className="t-label">↓ Down</div>
            <div className="t-value mono">{curDown.toFixed(1)} <span className="t-unit">Mbit/s</span></div>
            {!noHistory && <Sparkline data={downs} width={140} height={32} area color="var(--info)" />}
          </div>
          <div className="throughput-tile">
            <div className="t-label">↑ Up</div>
            <div className="t-value mono">{curUp.toFixed(1)} <span className="t-unit">Mbit/s</span></div>
            {!noHistory && <Sparkline data={ups} width={140} height={32} area color="var(--accent)" />}
          </div>
        </div>
      )}
      {!noLiveData && (
        <div className="throughput-foot" style={{ marginTop: 8 }}>
          <span className="dimmer mono" style={{ fontSize: 11 }}>
            Peak ↓ {throughput?.peak_down_mbit ?? 0} Mbit/s
          </span>
          <span className="dimmer mono" style={{ fontSize: 11 }}>
            Peak ↑ {throughput?.peak_up_mbit ?? 0} Mbit/s
          </span>
        </div>
      )}
    </div>
  );
}

function IspQualityCard({ metrics }: { metrics: IspMetrics }) {
  const latency = metrics.latency_ms;
  const jitter = metrics.jitter_ms;
  const loss = metrics.packet_loss_pct;
  // Status klassifiziert anhand der ISM-Werte (ITU-T Y.1541 G-class
  // Anhaltspunkt: <40 ms latenz ok, 40–100 ms warn, sonst err).
  const latencyTone = latency == null ? 'idle' : latency < 40 ? 'ok' : latency < 100 ? 'warn' : 'err';
  const jitterTone = jitter == null ? 'idle' : jitter < 5 ? 'ok' : jitter < 15 ? 'warn' : 'err';
  const lossTone = loss == null ? 'idle' : loss < 1 ? 'ok' : loss < 3 ? 'warn' : 'err';
  return (
    <div className="grid-12" style={{ marginBottom: 16 }}>
      <div className="card col-12">
        <div className="card-h">
          <h3>ISP-Qualität <span className="h3-sub">· letzte 5 min · Internet Status Monitor</span></h3>
          <span className="dimmer mono" style={{ fontSize: 11 }}>{metrics.isp_name ?? 'unbekannt'}</span>
        </div>
        <div className="isp-quality-grid">
          <IspQualityTile label="Latenz" value={latency} unit="ms" tone={latencyTone} />
          <IspQualityTile label="Jitter" value={jitter} unit="ms" tone={jitterTone} />
          <IspQualityTile label="Paketverlust" value={loss} unit="%" tone={lossTone} />
          <IspQualityTile label="Download" value={metrics.download_mbit} unit="Mbit/s" />
          <IspQualityTile label="Upload" value={metrics.upload_mbit} unit="Mbit/s" />
        </div>
      </div>
    </div>
  );
}

function IspQualityTile({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: number | null;
  unit: string;
  tone?: 'ok' | 'warn' | 'err' | 'idle';
}) {
  const numClass = tone === 'warn' ? 'warn' : tone === 'err' ? 'err' : '';
  return (
    <div className="isp-tile">
      <span className="isp-tile-label">{label}</span>
      <span className={`isp-tile-value mono ${numClass}`}>
        {value == null ? '—' : value < 10 ? value.toFixed(2) : value.toFixed(1)}
        <span className="isp-tile-unit">{unit}</span>
      </span>
    </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{device.name}</span>
            <span className={`badge ${status}`}><Dot status={status} /> {device.state}</span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            <span className="mono">{device.model ?? '—'}</span> · {role}
            {device.ip && <> · <span className="mono">{device.ip}</span></>}
            {device.firmware && <> · <span className="mono dimmer">fw {device.firmware}</span></>}
          </span>
        </div>
        {device.uptime_s > 0 && (
          <span className="mono dimmer" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            up {fmtUptime(device.uptime_s)}
          </span>
        )}
      </div>
      <div className="device-metrics">
        <DeviceMetricBar label="CPU" pct={device.cpu_pct} />
        <DeviceMetricBar label="RAM" pct={device.mem_pct} />
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

function DeviceMetricBar({ label, pct }: { label: string; pct: number | null }) {
  const value = pct ?? 0;
  const tone = pct == null ? null : pct > 85 ? 'err' : pct > 70 ? 'warn' : 'ok';
  const fillColor = tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="dev-metric">
      <span className="dev-metric-label">{label}</span>
      <div className="cell-bar" style={{ justifyContent: 'flex-start' }}>
        <div className="bar" style={{ flex: 1 }}>
          <div className="bar-fill" style={{ width: `${value}%`, background: fillColor }} />
        </div>
        <span className="mono" style={{ fontSize: 11.5, width: 40, textAlign: 'right' }}>
          {pct == null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
    </div>
  );
}
