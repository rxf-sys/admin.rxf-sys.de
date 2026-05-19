import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  NetworkSnapshot,
  NetworkThroughput,
  TunnelStatus,
  UnifiDevice,
} from '../types';
import { Dot } from './primitives';

interface Props {
  network: NetworkSnapshot | null;
  tunnel: TunnelStatus | null;
}

const COLORS = ['var(--info)', 'var(--warn)', 'var(--accent)', 'var(--text-3)', '#9b59ff'];

export function NetworkPanel({ network, tunnel }: Props) {
  const [throughput, setThroughput] = useState<NetworkThroughput | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      api
        .networkThroughput(1, ctrl.signal)
        .then(setThroughput)
        .catch(() => {
          /* keep stale data on error */
        });
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, []);

  const errored = network && network.reachable === false;
  const isps = network?.isp ?? '—';
  const linkStr =
    network?.link_down_mbit && network?.link_up_mbit
      ? `${Math.round(network.link_down_mbit)} / ${Math.round(network.link_up_mbit)} Mbit`
      : '—';
  const devices = network?.devices ?? [];

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

      {errored ? (
        <div className="card">
          <div className="card-h">
            <h3>UniFi unerreichbar</h3>
            <span className="badge err">
              <span className="dot err" /> ERROR
            </span>
          </div>
          <div className="dim" style={{ fontSize: 13 }}>
            {network?.error ?? 'Konfiguration prüfen.'}
          </div>
        </div>
      ) : (
        <>
          <div className="grid-12" style={{ marginBottom: 14 }}>
            <div className="col-4 card">
              <div className="card-h">
                <h3>WAN · DDNS</h3>
                <span className="badge ok">
                  <span className="dot ok" /> {tunnel?.wan_ip ? 'SYNC' : '—'}
                </span>
              </div>
              <div className="ov-rows">
                <div className="ov-row">
                  <span className="dim">Public IP</span>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {tunnel?.wan_ip ?? network?.wan_ip ?? '—'}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">ISP</span>
                  <span style={{ fontSize: 13 }}>{isps}</span>
                </div>
                <div className="ov-row">
                  <span className="dim">Link</span>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {linkStr}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">Tunnel</span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--ok)' }}>
                    {tunnel?.status ?? '—'}
                  </span>
                </div>
              </div>
            </div>
            <div className="col-8 card">
              <ThroughputChart
                throughput={throughput}
                liveDown={network?.throughput_down_mbit ?? 0}
                liveUp={network?.throughput_up_mbit ?? 0}
                authMode={network?.auth_mode ?? 'none'}
              />
            </div>
          </div>

          {devices.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="dash-section-head">
                <h2>UniFi Devices <span className="count">· {devices.length} online</span></h2>
              </div>
              <div className="grid-12">
                {devices.map((d) => (
                  <div key={d.id} className="col-6 card device-card">
                    <DeviceCard device={d} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid-12" style={{ marginBottom: 14 }}>
            <div className="col-5 card">
              <div className="card-h">
                <h3>VLANs</h3>
                <span className="dimmer mono" style={{ fontSize: 11 }}>
                  {network?.networks?.length ?? 0}
                </span>
              </div>
              <div className="vlan-list">
                {(network?.networks ?? []).length === 0 ? (
                  <div className="dimmer" style={{ fontSize: 12 }}>
                    Keine VLANs konfiguriert.
                  </div>
                ) : (
                  (network?.networks ?? []).map((n, i) => (
                    <div key={`${n.name}-${n.vlan ?? i}`} className="vlan-row">
                      <span
                        className="vlan-swatch"
                        style={{ background: COLORS[i % COLORS.length] }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{n.name}</div>
                        <div className="mono dim" style={{ fontSize: 11 }}>
                          VLAN {n.vlan ?? '—'}
                        </div>
                      </div>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                        {n.clients}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="col-7 card flat">
              <div className="card-h">
                <h3>Top Clients</h3>
                <span className="dimmer mono" style={{ fontSize: 11 }}>
                  Daten nicht verfügbar
                </span>
              </div>
              <div className="dimmer" style={{ fontSize: 12, lineHeight: 1.55 }}>
                Die UniFi Integration API (v10.x) gibt keine pro-Client-Bandbreite zurück;
                die Legacy-Cookie-API hat dasselbe Limit. Wired/Wireless-Summen sind in der
                WAN-Card oben sichtbar.
                <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
                  WIRED {network?.clients_wired ?? 0} · WIRELESS {network?.clients_wireless ?? 0}{' '}
                  · TOTAL {network?.clients_total ?? 0}
                </div>
              </div>
            </div>
          </div>

          <div className="grid-12">
            <div className="col-12 card flat">
              <div className="card-h">
                <h3>Network Events</h3>
                <span className="dimmer mono" style={{ fontSize: 11 }}>
                  Daten nicht verfügbar
                </span>
              </div>
              <div className="dimmer" style={{ fontSize: 12, lineHeight: 1.55 }}>
                UniFi exponiert keine Verbindungs-Events über die REST-APIs.
                Ein Event-Stream wäre nur über MQTT oder das Site-Manager-WebSocket möglich
                und ist nicht Teil dieser Integration.
              </div>
            </div>
          </div>
        </>
      )}
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
  const w = 600;
  const h = 110;
  const downs = samples.map((s) => s.down_mbit);
  const ups = samples.map((s) => s.up_mbit);
  const max = Math.max(...downs, ...ups, liveDown, liveUp, 1) * 1.15;
  const stepX = samples.length > 1 ? w / (samples.length - 1) : w;

  const renderArea = (data: number[], color: string, fill: string) => {
    if (data.length === 0) return null;
    const pts: [number, number][] = data.map((v, i) => [
      i * stepX,
      h - (v / max) * (h - 8) - 4,
    ]);
    const path = pts
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
    const area = `${path} L${w},${h} L0,${h} Z`;
    return (
      <>
        <path d={area} fill={fill} />
        <path d={path} fill="none" stroke={color} strokeWidth="1.4" />
      </>
    );
  };

  const noHistory = samples.length < 2;
  const apiKeyNoThroughput = authMode === 'api-key' && liveDown === 0 && liveUp === 0;

  return (
    <>
      <div className="card-h">
        <h3>WAN Throughput · 1h</h3>
        <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--info)' }} />
            DOWN{' '}
            <span className="mono" style={{ color: 'var(--text-1)', marginLeft: 4 }}>
              {liveDown.toFixed(1)} Mbit/s
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)' }} />
            UP{' '}
            <span className="mono" style={{ color: 'var(--text-1)', marginLeft: 4 }}>
              {liveUp.toFixed(1)} Mbit/s
            </span>
          </span>
        </div>
      </div>
      {apiKeyNoThroughput ? (
        <div className="dimmer" style={{ fontSize: 12, lineHeight: 1.55 }}>
          UniFi Integration API liefert keinen Live-Durchsatz (nur Legacy-Cookie-Auth tut das).
          Daher kein Chart.
        </div>
      ) : noHistory ? (
        <div className="dimmer" style={{ fontSize: 12 }}>
          Sammle Verlauf — Sampling-Loop alle 60 s.
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: 120, display: 'block' }}
            aria-label="WAN Throughput Verlauf"
          >
            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1="0"
                x2={w}
                y1={h * f}
                y2={h * f}
                stroke="var(--border)"
                strokeWidth="1"
                strokeDasharray="2 4"
              />
            ))}
            {renderArea(downs, 'var(--info)', 'var(--info-soft)')}
            {renderArea(ups, 'var(--accent)', 'var(--accent-soft)')}
          </svg>
          <div
            className="dimmer mono"
            style={{ fontSize: 11, marginTop: 6, display: 'flex', gap: 14 }}
          >
            <span>
              peak ↓ <strong style={{ color: 'var(--text-1)' }}>{throughput?.peak_down_mbit ?? 0} Mbit/s</strong>
            </span>
            <span>
              peak ↑ <strong style={{ color: 'var(--text-1)' }}>{throughput?.peak_up_mbit ?? 0} Mbit/s</strong>
            </span>
          </div>
        </>
      )}
    </>
  );
}

function DeviceCard({ device }: { device: UnifiDevice }) {
  const status =
    device.state === 'ONLINE' ? 'ok' : device.state === 'OFFLINE' ? 'err' : 'warn';
  return (
    <>
      <div className="dev-head">
        <Dot status={status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{device.name}</div>
          <div className="mono dim" style={{ fontSize: 11 }}>
            {device.model ?? '—'} · {device.ip ?? '—'}
          </div>
        </div>
        {device.is_gateway && <span className="badge ok">GW</span>}
        {device.firmware && (
          <span className="badge" title={`Firmware ${device.firmware}`} style={{ fontSize: 9 }}>
            {device.firmware}
          </span>
        )}
      </div>
      <div className="dev-metrics">
        <div className="dev-metric">
          <span className="dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            State
          </span>
          <span className="mono" style={{ fontSize: 12 }}>
            {device.state}
          </span>
        </div>
        <div className="dev-metric">
          <span className="dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Clients
          </span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
            {device.clients}
          </span>
        </div>
        <div className="dev-metric">
          <span className="dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Role
          </span>
          <span className="mono" style={{ fontSize: 12 }}>
            {device.is_gateway ? 'Gateway' : 'Device'}
          </span>
        </div>
      </div>
    </>
  );
}

