import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SectionNav } from './SectionNav';
import type { Section } from '../hooks/useSection';

const ZERO_ALERTS: Record<Section, number> = {
  overview: 0,
  server: 0,
  network: 0,
  backup: 0,
  cloudflare: 0,
};

describe('SectionNav', () => {
  it('renders all five tabs with the active one marked', () => {
    render(<SectionNav active="server" onChange={vi.fn()} alerts={ZERO_ALERTS} />);
    expect(screen.getByRole('tab', { name: /Übersicht/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: /Server/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Netzwerk/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Backup/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Cloudflare/i })).toBeInTheDocument();
  });

  it('emits onChange when clicking a tab', () => {
    const onChange = vi.fn();
    render(<SectionNav active="overview" onChange={onChange} alerts={ZERO_ALERTS} />);
    fireEvent.click(screen.getByRole('tab', { name: /Backup/i }));
    expect(onChange).toHaveBeenCalledWith('backup');
  });

  it('shows an alert pill when a section has issues', () => {
    render(
      <SectionNav
        active="overview"
        onChange={vi.fn()}
        alerts={{ ...ZERO_ALERTS, cloudflare: 3 }}
      />,
    );
    const tab = screen.getByRole('tab', { name: /Cloudflare/i });
    expect(tab.querySelector('.section-tab-alerts')?.textContent).toBe('3');
  });

  it('hides the alert pill when count is zero', () => {
    render(<SectionNav active="overview" onChange={vi.fn()} alerts={ZERO_ALERTS} />);
    expect(document.querySelector('.section-tab-alerts')).toBeNull();
  });
});
