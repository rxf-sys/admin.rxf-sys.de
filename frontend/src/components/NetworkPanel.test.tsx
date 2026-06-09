import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NetworkPanel } from './NetworkPanel';
import type { IspMetrics, NetworkSnapshot, TunnelStatus } from '../types';

// NetworkPanel polls api.networkThroughput for the live-throughput history.
// Stub it to an empty (storage-disabled) response so the card falls back to
// the ISM speed-test values — the exact scenario in the user's deployment.
vi.mock('../api/client', () => ({
  api: {
    networkThroughput: vi.fn(async () => ({
      hours: 1,
      enabled: false,
      peak_down_mbit: 0,
      peak_up_mbit: 0,
      samples: [],
    })),
  },
}));

const ISM: IspMetrics = {
  isp_name: 'Deutsche Telekom AG',
  isp_asn: '3320',
  public_ip: '79.255.158.101',
  latency_ms: 7,
  max_latency_ms: 23,
  jitter_ms: null,
  packet_loss_pct: 0,
  download_mbit: 100,
  upload_mbit: 40,
  uptime_pct: 99.9,
  host_name: 'Cloud-Gateway-Ultra-RX',
};

function snapshot(over: Partial<NetworkSnapshot> = {}): NetworkSnapshot {
  return {
    wan_ip: '79.255.158.101',
    isp: 'Deutsche Telekom AG',
    link_down_mbit: null,
    link_up_mbit: null,
    throughput_down_mbit: 0,
    throughput_up_mbit: 0,
    networks: [{ name: 'Default', vlan: 1, clients: 0 }],
    clients_total: 24,
    clients_wired: 8,
    clients_wireless: 16,
    devices: [
      {
        id: 'gw1',
        name: 'Cloud Gateway Ultra RX',
        model: 'UCG Ultra',
        ip: '79.255.158.101',
        mac: 'cc',
        state: 'ONLINE',
        firmware: '5.1.15',
        is_gateway: true,
        clients: 0,
        cpu_pct: null,
        mem_pct: null,
        uptime_s: 500000,
        ports_used: 2,
        ports_total: 5,
      },
    ],
    isp_metrics: ISM,
    reachable: true,
    error: null,
    auth_mode: 'api-key',
    ...over,
  };
}

const tunnel: TunnelStatus = {
  id: 't',
  name: 'main',
  status: 'healthy',
  connections: 4,
  regions: [],
  cloudflared_version: '1',
  wan_ip: '79.255.158.101',
  reachable: true,
  error: null,
};

describe('NetworkPanel — ISM-only deployment (no legacy auth)', () => {
  it('shows the ISM speed test in the Durchsatz card instead of 0.0', async () => {
    render(<NetworkPanel network={snapshot()} tunnel={tunnel} pollMs={0} />);
    // Wait for the throughput poll to resolve (empty → ISM fallback).
    await waitFor(() => expect(screen.getByText('Speedtest · ISM')).toBeInTheDocument());
    // 100/40 from ISM (appears here AND in the ISP-Qualität card), NOT 0.0.
    expect(screen.getAllByText('100.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('40.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
  });

  it('shows Max-Latenz from ISM (not an empty Jitter tile)', () => {
    render(<NetworkPanel network={snapshot()} tunnel={tunnel} pollMs={0} />);
    expect(screen.getByText('Max-Latenz')).toBeInTheDocument();
    expect(screen.queryByText('Jitter')).not.toBeInTheDocument();
    expect(screen.getByText('23.0')).toBeInTheDocument(); // max_latency_ms, toFixed(1)
  });

  it('fills the WAN card speed + uptime from ISM when Integration has none', () => {
    render(<NetworkPanel network={snapshot()} tunnel={tunnel} pollMs={0} />);
    expect(screen.getByText('WAN-Speed')).toBeInTheDocument();
    expect(screen.getByText('100 / 40 Mbit')).toBeInTheDocument();
    expect(screen.getByText('WAN-Uptime')).toBeInTheDocument();
    expect(screen.getByText('99.9%')).toBeInTheDocument();
  });

  it('explains missing device CPU/RAM instead of rendering empty bars', () => {
    render(<NetworkPanel network={snapshot()} tunnel={tunnel} pollMs={0} />);
    expect(screen.getByText(/Nicht über die Integration API verfügbar/i)).toBeInTheDocument();
  });

  it('shows the honest empty state when neither live throughput nor ISM exist', async () => {
    const noIsm = snapshot({ isp_metrics: null });
    render(<NetworkPanel network={noIsm} tunnel={tunnel} pollMs={0} />);
    await waitFor(() =>
      expect(screen.getByText(/Kein Live-Durchsatz verfügbar/i)).toBeInTheDocument(),
    );
  });
});
