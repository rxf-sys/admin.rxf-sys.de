// @vitest-environment jsdom
import type { EntityResponse } from '@rxf/contracts';
import type { DataAccess, PluginConfig } from '@rxf/web-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UptimeConfigForm from './config-form.tsx';
import { trustCertificate } from './trust.ts';
import ChecksWidget from './widgets/checks.tsx';
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

  it('pins certificate checks by host and port', () => {
    const config = {
      checks: [
        { type: 'tls', name: 'nas', host: 'nas.lan', port: 5001 },
        { type: 'tls', name: 'web', host: 'nas.lan' },
        { type: 'tcp', name: 'ssh', host: 'nas.lan', port: 5001 },
      ],
    };
    const pinned = trustCertificate(config, { ...certificate, origin: 'tls://nas.lan:5001' }).checks as Record<
      string,
      unknown
    >[];
    expect(pinned.map((c) => c.pinSha256 ?? null)).toEqual(['a'.repeat(64), null, null]);
    const v6 = trustCertificate(
      { checks: [{ type: 'tls', name: 'v6', host: 'fd00::1' }] },
      { ...certificate, origin: 'tls://[fd00::1]:443' },
    ).checks as Record<string, unknown>[];
    expect(v6[0]?.tlsMode).toBe('pin-leaf');
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

describe('UptimeConfigForm check types', () => {
  function renderForm(value: PluginConfig | null) {
    const onChange = vi.fn();
    render(<UptimeConfigForm value={value} onChange={onChange} locale="de" />);
    return () => onChange.mock.calls.at(-1) as [PluginConfig, boolean];
  }

  it('keeps the fields of other check types and their extras', () => {
    const value = {
      checks: [
        { type: 'tcp', name: 'ssh', host: 'pve.lan', port: 22, intervalS: 60 },
        { type: 'dns', name: 'mx', query: 'rxf-sys.de', recordType: 'MX', server: '1.1.1.1' },
        { type: 'tls', name: 'cert', host: 'rxf-sys.de', warnDays: 21, critDays: 3 },
        { type: 'icmp', name: 'gw', host: '192.168.2.1', count: 5 },
      ],
      slowThresholdMs: 800,
      allowBlockedTargets: false,
    };
    expect(renderForm(value)()).toEqual([value, true]);
  });

  it('switches the type, shows its fields and validates them', () => {
    const last = renderForm({
      checks: [{ name: 'x', url: 'http://a/' }],
      slowThresholdMs: 800,
      allowBlockedTargets: false,
    });
    fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'tcp' } });
    expect(screen.queryByLabelText('URL')).toBeNull();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '-oProxy' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } });
    fireEvent.change(screen.getByLabelText('Intervall (s)'), { target: { value: '5' } });
    expect(screen.getByText('Bitte einen Hostnamen oder eine IP-Adresse angeben.')).toBeTruthy();
    expect(screen.getByText('Port zwischen 1 und 65535.')).toBeTruthy();
    expect(screen.getByText('Zwischen 10 und 3600 Sekunden.')).toBeTruthy();
    expect(last()[1]).toBe(false);
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'nas.lan' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '445' } });
    fireEvent.change(screen.getByLabelText('Intervall (s)'), { target: { value: '120' } });
    expect(last()).toEqual([
      {
        checks: [{ type: 'tcp', name: 'x', host: 'nas.lan', port: 445, intervalS: 120 }],
        slowThresholdMs: 800,
        allowBlockedTargets: false,
      },
      true,
    ]);

    fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'dns' } });
    fireEvent.change(screen.getByLabelText('Name', { selector: '[id$="-query"]' }), {
      target: { value: 'rxf-sys.de' },
    });
    fireEvent.change(screen.getByLabelText('Eintrag'), { target: { value: 'AAAA' } });
    fireEvent.change(screen.getByLabelText('DNS-Server'), { target: { value: 'dns.google' } });
    expect(screen.getByText('Der DNS-Server muss eine IP-Adresse sein.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('DNS-Server'), { target: { value: '2606:4700::1111' } });
    fireEvent.change(screen.getByLabelText('Erwartete Antwort'), { target: { value: '2a01::1' } });
    expect(last()[0].checks).toEqual([
      {
        type: 'dns',
        name: 'x',
        query: 'rxf-sys.de',
        recordType: 'AAAA',
        server: '2606:4700::1111',
        expected: '2a01::1',
        intervalS: 120,
      },
    ]);

    fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'tls' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'rxf-sys.de' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Warnen ab (Tage)'), { target: { value: '400' } });
    expect(screen.getByText('Zwischen 1 und 365 Tagen.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Warnen ab (Tage)'), { target: { value: '30' } });
    expect(last()).toEqual([
      {
        checks: [{ type: 'tls', name: 'x', host: 'rxf-sys.de', warnDays: 30, intervalS: 120 }],
        slowThresholdMs: 800,
        allowBlockedTargets: false,
      },
      true,
    ]);

    fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'icmp' } });
    expect(screen.queryByLabelText('Port')).toBeNull();
    expect(last()[0].checks).toEqual([{ type: 'icmp', name: 'x', host: 'rxf-sys.de', intervalS: 120 }]);
  });
});

describe('ChecksWidget', () => {
  const entity = (
    id: number,
    status: EntityResponse['status'],
    statusReason: string | null,
    attrs: Record<string, unknown>,
  ) => ({
    id,
    instanceId: 'i',
    pluginId: 'uptime',
    kind: 'Service' as const,
    externalId: `e${id}`,
    name: `Check ${id}`,
    status,
    statusReason,
    lastSeen: 1,
    attrs,
    updatedAt: 1,
  });

  it('names the target and says more than slow or failing where the reason allows', async () => {
    const data: DataAccess = {
      entities: async () => [
        entity(1, 'warn', 'TLS_EXPIRING', { type: 'tls', target: 'rxf-sys.de:443', daysLeft: 9, responseMs: 30 }),
        entity(2, 'crit', 'TLS_EXPIRED', { type: 'tls', target: 'old.lan:443', daysLeft: -2, responseMs: 30 }),
        entity(3, 'warn', 'ICMP_LOSS', { type: 'icmp', target: 'gw.lan', responseMs: 1.5 }),
        entity(4, 'unknown', 'ICMP_UNAVAILABLE', { type: 'icmp', target: 'nas.lan', responseMs: null }),
        entity(5, 'ok', null, { endpoint: 'https://legacy.lan/x', responseMs: 12 }),
      ],
      series: async () => [],
      points: async () => ({ seriesId: 0, resolution: 'raw', stepMs: 1000, points: [] }),
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChecksWidget instanceId="i" size="M" data={data} locale="de" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Läuft bald ab')).toBeTruthy();
    expect(screen.getByText('noch 9 Tage')).toBeTruthy();
    expect(screen.getByText('Abgelaufen')).toBeTruthy();
    expect(screen.getByText('abgelaufen')).toBeTruthy();
    expect(screen.getByText('Paketverlust')).toBeTruthy();
    expect(screen.getByText('Ping nicht möglich')).toBeTruthy();
    expect(screen.getByText('rxf-sys.de:443')).toBeTruthy();
    expect(screen.getByText('legacy.lan')).toBeTruthy();
    expect(screen.getByText('3 von 5 erreichbar')).toBeTruthy();
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
