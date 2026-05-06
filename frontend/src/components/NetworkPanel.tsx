import { useEffect, useRef } from 'react';
import type { NetworkSnapshot, TunnelStatus } from '../types';
import { Num } from './primitives';

interface Props {
  network: NetworkSnapshot | null;
  tunnel: TunnelStatus | null;
}

const HISTORY_LEN = 60;

const upHist: number[] = [];
const downHist: number[] = [];

const COLORS = ['var(--info)', 'var(--warn)', 'var(--accent)', 'var(--text-3)', '#9b59ff'];

export function NetworkPanel({ network, tunnel }: Props) {
  const lastSig = useRef('');
  const sig = `${network?.throughput_up_mbit ?? 0}|${network?.throughput_down_mbit ?? 0}`;
  useEffect(() => {
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    upHist.push(network?.throughput_up_mbit ?? 0);
    downHist.push(network?.throughput_down_mbit ?? 0);
    while (upHist.length > HISTORY_LEN) upHist.shift();
    while (downHist.length > HISTORY_LEN) downHist.shift();
  }, [sig, network]);

  const w = 600;
  const h = 120;
  const max = Math.max(...upHist, ...downHist, 1) * 1.15;
  const stepX = upHist.length > 1 ? w / (upHist.length - 1) : w;
  const renderArea = (data: number[], color: string, fill: string) => {
    if (data.length === 0) return null;
    const pts: [number, number][] = data.map((v, i) => [i * stepX, h - (v / max) * (h - 8) - 4]);
    const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${path} L${w},${h} L0,${h} Z`;
    return (
      <>
        <path d={area} fill={fill} />
        <path d={path} fill="none" stroke={color} strokeWidth="1.4" />
      </>
    );
  };

  const isps = network?.isp ?? '—';
  const link =
    network?.link_down_mbit && network?.link_up_mbit
      ? `${Math.round(network.link_down_mbit)}/${Math.round(network.link_up_mbit)}`
      : '—';

  return (
    <section className="dash-section">
      <div className="section-head">
        <h2>Netzwerk</h2>
        <div className="section-tools">
          <span className="dimmer mono" style={{ fontSize: 11 }}>
            live · letzte {upHist.length} Polls
          </span>
        </div>
      </div>
      <div className="net-grid">
        <div className="card" style={{ padding: 18, gridColumn: 'span 2' }}>
          <div className="card-h">
            <h3>WAN Throughput</h3>
            <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--info)' }} />
                DOWN{' '}
                <span className="mono" style={{ color: 'var(--text-1)', marginLeft: 4 }}>
                  {(network?.throughput_down_mbit ?? 0).toFixed(1)} Mbit/s
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)' }} />
                UP{' '}
                <span className="mono" style={{ color: 'var(--text-1)', marginLeft: 4 }}>
                  {(network?.throughput_up_mbit ?? 0).toFixed(1)} Mbit/s
                </span>
              </span>
            </div>
          </div>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: 140, display: 'block' }}
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
            {renderArea(downHist, 'var(--info)', 'var(--info-soft)')}
            {renderArea(upHist, 'var(--accent)', 'var(--accent-soft)')}
          </svg>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>WAN & DDNS</h3>
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
              <span className="dim">Tunnel</span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--ok)' }}>
                {tunnel?.status ?? '—'}
              </span>
            </div>
            <div className="ov-row">
              <span className="dim">ISP</span>
              <span style={{ fontSize: 13 }}>{isps}</span>
            </div>
            <div className="ov-row">
              <span className="dim">Link</span>
              <Num value={link} unit="Mbit" size="md" />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>UniFi Clients</h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              {network?.clients_total ?? 0} total
            </span>
          </div>
          <div className="net-rows">
            {(network?.networks ?? []).map((n, i) => (
              <div key={`${n.name}-${n.vlan ?? i}`} className="net-row">
                <span
                  className="net-dot"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                <span style={{ fontSize: 13 }}>{n.name}</span>
                <span className="mono dim" style={{ fontSize: 11 }}>
                  VLAN {n.vlan ?? '—'}
                </span>
                <span className="mono" style={{ fontSize: 13, marginLeft: 'auto', fontWeight: 600 }}>
                  {n.clients}
                </span>
              </div>
            ))}
            {(!network || network.networks.length === 0) && (
              <div className="dimmer mono" style={{ fontSize: 11, padding: 8 }}>
                UniFi nicht konfiguriert oder nicht erreichbar
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
