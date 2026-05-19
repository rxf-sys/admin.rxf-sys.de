import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Drawer } from './Drawer';
import type { Guest, ServiceStatus } from '../types';

vi.mock('../api/client', () => ({
  api: {
    serviceHistory: vi.fn().mockResolvedValue({
      service_id: 'vault',
      hours: 24,
      enabled: true,
      uptime_pct: 99.8,
      p95_ms: 180,
      last_incident_iso: null,
      samples: [
        { ts: 1, status: 'ok', ms: 95 },
        { ts: 2, status: 'ok', ms: 110 },
        { ts: 3, status: 'warn', ms: 750 },
      ],
    }),
    events: vi.fn().mockResolvedValue({
      events: [
        { ts: 100, event: 'svc.degraded', service_id: 'vault', detail: 'slow probe' },
      ],
    }),
    guestTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    taskLog: vi.fn().mockResolvedValue({ lines: [] }),
  },
}));

const svc: ServiceStatus = {
  id: 'vault',
  name: 'vault',
  sub: 'vault.rxf-sys.de',
  icon: 'lock',
  desc: 'Vaultwarden',
  status: 'ok',
  ms: 95,
  ext: true,
  internal: true,
  code_ext: 200,
  code_int: 200,
  note: null,
  uptime_pct: 99.8,
  p95_ms: 180,
  last_incident_iso: '2026-05-19T08:00:00Z',
};

const guests: Guest[] = [
  {
    id: 102,
    name: 'vault',
    type: 'LXC',
    status: 'ok',
    running: true,
    ip: '192.168.2.203',
    service: 'Vaultwarden',
    cpu_pct: 0.5,
    ram_used_b: 100,
    ram_total_b: 1000,
    uptime_s: 86400,
  },
];

describe('Drawer (ServiceDrawer)', () => {
  it('renders nothing when svc is null', () => {
    const { container } = render(
      <Drawer open={false} svc={null} guests={guests} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the service name, sub, summary stats and reachability when open', async () => {
    render(<Drawer open={true} svc={svc} guests={guests} onClose={vi.fn()} />);
    // Header
    expect(screen.getByRole('heading', { level: 2, name: 'vault' })).toBeInTheDocument();
    expect(screen.getByText('vault.rxf-sys.de')).toBeInTheDocument();
    // Summary
    expect(screen.getByText('Response')).toBeInTheDocument();
    expect(screen.getByText('p95 · 24h')).toBeInTheDocument();
    expect(screen.getByText('Uptime · 30d')).toBeInTheDocument();
    expect(screen.getByText('180ms')).toBeInTheDocument();
    expect(screen.getByText('99.80%')).toBeInTheDocument();
    // Reachability
    expect(screen.getAllByText('EXT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('INT').length).toBeGreaterThan(0);
    // History + events arrive via mocked API
    await waitFor(() => {
      expect(screen.getByText(/svc.degraded/)).toBeInTheDocument();
    });
  });

  it('shows the linked container kv block when a matching guest exists', () => {
    render(<Drawer open={true} svc={svc} guests={guests} onClose={vi.fn()} />);
    expect(screen.getByText('Container')).toBeInTheDocument();
    expect(screen.getByText('192.168.2.203')).toBeInTheDocument();
  });
});
