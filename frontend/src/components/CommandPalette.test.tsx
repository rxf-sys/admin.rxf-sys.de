import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import type { Guest, ServiceStatus } from '../types';

const services: ServiceStatus[] = [
  {
    id: 'vault', name: 'vault', sub: 'vault.rxf-sys.de', icon: 'lock',
    desc: 'Vaultwarden', status: 'ok', ms: 100, ext: true, internal: true,
    code_ext: 200, code_int: 200, note: null,
  },
  {
    id: 'cloud', name: 'cloud', sub: 'cloud.rxf-sys.de', icon: 'cloud',
    desc: 'Nextcloud', status: 'err', ms: 4000, ext: false, internal: false,
    code_ext: null, code_int: null, note: null,
  },
];

const guests: Guest[] = [
  {
    id: 100, name: 'nas', type: 'LXC', status: 'ok', running: true, ip: '192.168.2.201',
    service: 'Samba (NAS)', cpu_pct: 0.1, ram_used_b: 1, ram_total_b: 10, uptime_s: 1000,
  },
];

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    services,
    guests,
    onSelectService: vi.fn(),
    onRestartGuest: vi.fn(),
    onRefresh: vi.fn(),
    onToggleTheme: vi.fn(),
    ...overrides,
  };
  render(<CommandPalette {...props} />);
  return props;
}

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    render(
      <CommandPalette
        open={false}
        onClose={vi.fn()}
        services={services}
        guests={guests}
        onSelectService={vi.fn()}
        onRestartGuest={vi.fn()}
        onRefresh={vi.fn()}
        onToggleTheme={vi.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText(/Tippen f/i)).not.toBeInTheDocument();
  });

  it('shows services, containers and actions when open', () => {
    renderPalette();
    expect(screen.getByText('vault')).toBeInTheDocument();
    expect(screen.getByText('cloud')).toBeInTheDocument();
    expect(screen.getByText('nas')).toBeInTheDocument();
    expect(screen.getByText('Daten neu laden')).toBeInTheDocument();
  });

  it('filters fuzzily by query', () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/Tippen f/i);
    fireEvent.change(input, { target: { value: 'vlt' } });
    expect(screen.getByText('vault')).toBeInTheDocument();
    expect(screen.queryByText('cloud')).not.toBeInTheDocument();
  });

  it('selects service on Enter', () => {
    const props = renderPalette();
    const input = screen.getByPlaceholderText(/Tippen f/i);
    fireEvent.change(input, { target: { value: 'vault' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onSelectService).toHaveBeenCalledWith('vault');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const props = renderPalette();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });
});
