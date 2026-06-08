import { describe, expect, it } from 'vitest';
import { computeHealth, deriveAlerts } from './AttentionHero';
import type { BackupSummary, CertInfo, Guest, ServiceStatus, TunnelStatus } from '../types';

// --- minimal fixture factories -------------------------------------------

function guest(over: Partial<Guest> = {}): Guest {
  return {
    id: 100,
    name: 'ct-test',
    type: 'LXC',
    status: 'ok',
    running: true,
    ip: '192.168.2.100',
    service: null,
    cpu_pct: 5,
    ram_used_b: 1_000,
    ram_total_b: 10_000, // 10% by default
    uptime_s: 3600,
    ...over,
  };
}

function service(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'svc1',
    name: 'Service 1',
    sub: 'svc1.rxf-sys.de',
    icon: 'cloud',
    desc: '',
    status: 'ok',
    ms: 42,
    ext: true,
    internal: true,
    code_ext: 200,
    code_int: 200,
    note: null,
    custom: false,
    ext_monitored: true,
    internal_url: 'http://192.168.2.100',
    ext_url: null,
    uptime_pct: 99.9,
    p95_ms: 80,
    last_incident_iso: null,
    ...over,
  };
}

function cert(over: Partial<CertInfo> = {}): CertInfo {
  return { domain: 'rxf-sys.de', issuer: 'LE', days_left: 90, ...over };
}

function tunnel(over: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    id: 't1',
    name: 'main',
    status: 'healthy',
    connections: 4,
    regions: [],
    cloudflared_version: '2026.1',
    wan_ip: '1.2.3.4',
    reachable: true,
    error: null,
    ...over,
  };
}

function backups(over: Partial<BackupSummary> = {}): BackupSummary {
  return {
    jobs: [],
    datastore: null,
    last_success_iso: null,
    success_today: 1,
    total_today: 1,
    reachable: true,
    error: null,
    ...over,
  };
}

const EMPTY = {
  guests: [],
  services: [],
  certs: [],
  backups: null,
  tunnel: null,
  certWarnDays: 14,
};

describe('deriveAlerts — guest RAM/CPU thresholds', () => {
  it('flags RAM > 90% as crit', () => {
    const alerts = deriveAlerts({ ...EMPTY, guests: [guest({ ram_used_b: 9_500, ram_total_b: 10_000 })] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'ram-100', level: 'crit' });
    expect(alerts[0].actions).toContain('restart');
  });

  it('flags RAM between 80% and 90% as warn (regression: old threshold was 95%)', () => {
    const alerts = deriveAlerts({ ...EMPTY, guests: [guest({ ram_used_b: 8_500, ram_total_b: 10_000 })] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'ram-100', level: 'warn' });
    expect(alerts[0].actions).not.toContain('restart');
  });

  it('does not flag RAM at exactly 80%', () => {
    const alerts = deriveAlerts({ ...EMPTY, guests: [guest({ ram_used_b: 8_000, ram_total_b: 10_000 })] });
    expect(alerts).toHaveLength(0);
  });

  it('flags CPU > 90% as warn when RAM is fine', () => {
    const alerts = deriveAlerts({ ...EMPTY, guests: [guest({ cpu_pct: 95 })] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'cpu-100', level: 'warn' });
  });

  it('prioritises a RAM crit over a CPU warn for the same guest', () => {
    const alerts = deriveAlerts({
      ...EMPTY,
      guests: [guest({ cpu_pct: 99, ram_used_b: 9_900, ram_total_b: 10_000 })],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe('ram-100');
  });

  it('handles ram_total_b = 0 without dividing by zero', () => {
    const alerts = deriveAlerts({ ...EMPTY, guests: [guest({ ram_used_b: 5, ram_total_b: 0, cpu_pct: 1 })] });
    expect(alerts).toHaveLength(0);
  });
});

describe('deriveAlerts — services / certs / backups / tunnel', () => {
  it('flags an errored service as crit and a warn service as warn', () => {
    const alerts = deriveAlerts({
      ...EMPTY,
      services: [service({ id: 'a', status: 'err' }), service({ id: 'b', status: 'warn' })],
    });
    expect(alerts.map((a) => a.id).sort()).toEqual(['svc-a', 'svc-b']);
    expect(alerts.find((a) => a.id === 'svc-a')?.level).toBe('crit');
    expect(alerts.find((a) => a.id === 'svc-b')?.level).toBe('warn');
  });

  it('flags an expired cert as crit and a soon-to-expire cert per the 7-day rule', () => {
    const alerts = deriveAlerts({
      ...EMPTY,
      certWarnDays: 14,
      certs: [cert({ domain: 'a.de', days_left: 0 }), cert({ domain: 'b.de', days_left: 5 }), cert({ domain: 'c.de', days_left: 10 })],
    });
    expect(alerts.find((a) => a.id === 'cert-a.de')?.level).toBe('crit');
    expect(alerts.find((a) => a.id === 'cert-b.de')?.level).toBe('crit'); // <7d
    expect(alerts.find((a) => a.id === 'cert-c.de')?.level).toBe('warn'); // 7..14d
  });

  it('does not flag certs beyond the warn window', () => {
    const alerts = deriveAlerts({ ...EMPTY, certWarnDays: 14, certs: [cert({ days_left: 30 })] });
    expect(alerts).toHaveLength(0);
  });

  it('flags an unreachable PBS', () => {
    const alerts = deriveAlerts({ ...EMPTY, backups: backups({ reachable: false, error: 'timeout' }) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'backup-unreach', level: 'crit', msg: 'timeout' });
  });

  it('flags tunnel down as crit and degraded as warn, but ignores unreachable (= not configured)', () => {
    expect(deriveAlerts({ ...EMPTY, tunnel: tunnel({ status: 'down' }) })[0]).toMatchObject({ id: 'tunnel-down', level: 'crit' });
    expect(deriveAlerts({ ...EMPTY, tunnel: tunnel({ status: 'degraded' }) })[0]).toMatchObject({ id: 'tunnel-degraded', level: 'warn' });
    expect(deriveAlerts({ ...EMPTY, tunnel: tunnel({ status: 'down', reachable: false }) })).toHaveLength(0);
  });

  it('sorts crit before warn, then alphabetically by target', () => {
    const alerts = deriveAlerts({
      ...EMPTY,
      services: [
        service({ id: 'z', name: 'Zeta', status: 'warn' }),
        service({ id: 'a', name: 'Alpha', status: 'err' }),
        service({ id: 'm', name: 'Mike', status: 'err' }),
      ],
    });
    expect(alerts.map((a) => a.target)).toEqual(['Alpha', 'Mike', 'Zeta']);
  });
});

describe('computeHealth', () => {
  it('returns 100 for no alerts', () => {
    expect(computeHealth([])).toBe(100);
  });

  it('subtracts the documented weights per alert category', () => {
    // svc crit (-15) + ram warn (-5) + cpu warn (-4) = -24 → 76
    const alerts = deriveAlerts({
      ...EMPTY,
      services: [service({ id: 'a', status: 'err' })],
      guests: [
        guest({ id: 1, name: 'a', ram_used_b: 8_500, ram_total_b: 10_000 }),
        guest({ id: 2, name: 'b', cpu_pct: 95 }),
      ],
    });
    expect(computeHealth(alerts)).toBe(76);
  });

  it('floors at 0 for a flood of critical alerts', () => {
    const alerts = deriveAlerts({
      ...EMPTY,
      services: Array.from({ length: 10 }, (_, i) => service({ id: `s${i}`, name: `S${i}`, status: 'err' })),
    });
    // 10 × -15 = -150 → clamped to 0
    expect(computeHealth(alerts)).toBe(0);
  });

  it('weights a RAM crit (-12) heavier than a RAM warn (-5)', () => {
    const crit = deriveAlerts({ ...EMPTY, guests: [guest({ ram_used_b: 9_500, ram_total_b: 10_000 })] });
    const warn = deriveAlerts({ ...EMPTY, guests: [guest({ ram_used_b: 8_500, ram_total_b: 10_000 })] });
    expect(computeHealth(crit)).toBe(88);
    expect(computeHealth(warn)).toBe(95);
  });
});
