// @vitest-environment jsdom
import type { PluginConfig } from '@rxf/web-sdk';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UptimeConfigForm from './config-form.tsx';
import { trustCertificate } from './trust.ts';
import { Sparkline } from './widgets/sparkline.tsx';

afterEach(cleanup);

const certificate = {
  origin: 'https://pve.lan:8006',
  leafSha256: 'a'.repeat(64),
  spkiSha256: 'b'.repeat(64),
  subject: 'CN=pve',
  issuer: 'CN=pve',
  subjectAltName: null,
  validTo: 'Jan  1 00:00:00 2030 GMT',
  trusted: false,
};

describe('trustCertificate', () => {
  it('pins only the checks of that origin, default ports included', () => {
    const config = {
      checks: [
        { name: 'a', url: 'https://PVE.lan:8006/api' },
        { name: 'b', url: 'https://pve.lan/' },
        { name: 'c', url: 'not a url' },
      ],
    };
    expect(trustCertificate(config, certificate).checks).toEqual([
      { name: 'a', url: 'https://PVE.lan:8006/api', tlsMode: 'pin-leaf', pinSha256: 'a'.repeat(64) },
      { name: 'b', url: 'https://pve.lan/' },
      { name: 'c', url: 'not a url' },
    ]);
    const onDefaultPort = trustCertificate(
      { checks: [{ name: 'x', url: 'https://nas/' }] },
      { ...certificate, origin: 'https://nas:443' },
    );
    expect((onDefaultPort.checks as Record<string, unknown>[])[0]?.tlsMode).toBe('pin-leaf');
    expect(trustCertificate({}, certificate).checks).toEqual([]);
  });
});

describe('UptimeConfigForm', () => {
  function renderForm(value: PluginConfig | null) {
    const onChange = vi.fn();
    render(<UptimeConfigForm value={value} onChange={onChange} locale="de" />);
    return { onChange, last: () => onChange.mock.calls.at(-1) as [PluginConfig, boolean] };
  }

  it('keeps fields it does not edit and reports validity', () => {
    const { last } = renderForm({
      checks: [
        { name: 'pve', url: 'https://pve:8006/', method: 'HEAD', tlsMode: 'pin-leaf', pinSha256: 'f'.repeat(64) },
      ],
      slowThresholdMs: 500,
      allowBlockedTargets: true,
    });
    expect(last()).toEqual([
      {
        checks: [
          { name: 'pve', url: 'https://pve:8006/', method: 'HEAD', tlsMode: 'pin-leaf', pinSha256: 'f'.repeat(64) },
        ],
        slowThresholdMs: 500,
        allowBlockedTargets: true,
      },
      true,
    ]);
  });

  it('adds and removes checks, flags duplicate names and bad status lists, edits the other fields', () => {
    const { last } = renderForm(null);
    expect(last()[1]).toBe(false);
    expect((screen.getByRole('button', { name: 'Prüfung 1 entfernen' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'web' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://rxf-sys.de/' } });
    expect(last()[1]).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Prüfung hinzufügen' }));
    const names = screen.getAllByLabelText('Name');
    fireEvent.change(names[1] as HTMLElement, { target: { value: 'web' } });
    fireEvent.change(screen.getAllByLabelText('URL')[1] as HTMLElement, { target: { value: 'http://nas/' } });
    fireEvent.change(screen.getAllByLabelText('Erwartete Statuscodes')[1] as HTMLElement, { target: { value: '2xx' } });
    fireEvent.change(screen.getAllByLabelText('Methode')[1] as HTMLElement, { target: { value: 'HEAD' } });
    expect(screen.getByText('Jede Prüfung braucht einen eigenen Namen.')).toBeTruthy();
    expect(screen.getByText('Format: 200 oder 200-299, mehrere mit Komma.')).toBeTruthy();
    expect(last()[1]).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Prüfung 2 entfernen' }));
    fireEvent.change(screen.getByLabelText('Langsam ab (ms)'), { target: { value: '1200' } });
    fireEvent.click(screen.getByLabelText(/Prüfungen gegen diesen Host erlauben/));
    expect(last()).toEqual([
      {
        checks: [{ name: 'web', url: 'https://rxf-sys.de/', method: 'GET' }],
        slowThresholdMs: 1200,
        allowBlockedTargets: true,
      },
      true,
    ]);
  });
});

describe('Sparkline', () => {
  it('draws one path and names the range', () => {
    const { container } = render(
      <Sparkline
        points={[
          { ts: 0, avg: 10 },
          { ts: 1, avg: 30 },
          { ts: 2, avg: 20 },
        ]}
        locale="en"
      />,
    );
    expect(screen.getByRole('img', { name: 'Response time over the last 24 hours: 10 to 30 ms' })).toBeTruthy();
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M2\.0 26\.0 L60\.0 2\.0 L118\.0 14\.0$/);
  });
});
