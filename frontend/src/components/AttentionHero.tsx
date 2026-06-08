import type { BackupSummary, CertInfo, Guest, ServiceStatus, TunnelStatus } from '../types';
import { ICONS, fmtTimeAgo } from './primitives';

export interface Alert {
  id: string;
  level: 'crit' | 'warn' | 'info';
  target: string;
  sub: string;
  msg: string;
  iso: string | null;
  actions: ('inspect' | 'restart' | 'renew')[];
  /** Optional click handler — opens the matching drawer. */
  onClick?: () => void;
}

interface Props {
  guests: Guest[];
  services: ServiceStatus[];
  certs: CertInfo[];
  backups: BackupSummary | null;
  tunnel: TunnelStatus | null;
  certWarnDays: number;
  onInspectService?: (id: string) => void;
  onInspectGuest?: (id: number) => void;
}

// Health-Score-Schwellen — die Wahl bestimmt, wann ein Gast einen Alert
// triggert UND wie viele Punkte er vom Health-Score abzieht.
//   RAM > 90 %  ⇒ crit  (–12)   — Risiko von OOM-Kills bei VM/CT
//   RAM > 80 %  ⇒ warn (–5)     — sollte zeitnah angeschaut werden
//   CPU > 90 %  ⇒ warn (–4)     — Dauerlast, evtl. Engpass
// Service-Probes (err/warn), Cert-Ablauf, PBS-Erreichbarkeit und
// Cloudflare-Tunnel ergänzen die Gesamtwertung. Score = 100 − Σ penalty,
// auf [0, 100] gekappt.
const RAM_CRIT_PCT = 90;
const RAM_WARN_PCT = 80;
const CPU_WARN_PCT = 90;

const HEALTH_WEIGHTS = {
  svc_err: 15,
  svc_warn: 6,
  ram_crit: 12,
  ram_warn: 5,
  cpu_warn: 4,
  cert_crit: 10,
  cert_warn: 4,
  backup_fail: 8,
  tunnel_down: 15,
} as const;

export function deriveAlerts(p: Props): Alert[] {
  const out: Alert[] = [];
  for (const g of p.guests) {
    const ramPct = g.ram_total_b > 0 ? (g.ram_used_b / g.ram_total_b) * 100 : 0;
    if (ramPct > RAM_CRIT_PCT) {
      out.push({
        id: `ram-${g.id}`,
        level: 'crit',
        target: g.name,
        sub: g.ip ?? `CT/VM ${g.id}`,
        msg: `RAM-Auslastung bei ${Math.round(ramPct)}%`,
        iso: null,
        actions: ['inspect', 'restart'],
        onClick: () => p.onInspectGuest?.(g.id),
      });
    } else if (ramPct > RAM_WARN_PCT) {
      out.push({
        id: `ram-${g.id}`,
        level: 'warn',
        target: g.name,
        sub: g.ip ?? `CT/VM ${g.id}`,
        msg: `RAM-Auslastung erhöht (${Math.round(ramPct)}%)`,
        iso: null,
        actions: ['inspect'],
        onClick: () => p.onInspectGuest?.(g.id),
      });
    } else if (g.cpu_pct > CPU_WARN_PCT) {
      out.push({
        id: `cpu-${g.id}`,
        level: 'warn',
        target: g.name,
        sub: g.ip ?? `CT/VM ${g.id}`,
        msg: `CPU dauerhaft bei ${Math.round(g.cpu_pct)}%`,
        iso: null,
        actions: ['inspect'],
        onClick: () => p.onInspectGuest?.(g.id),
      });
    }
  }
  for (const s of p.services) {
    if (s.status === 'err') {
      out.push({
        id: `svc-${s.id}`,
        level: 'crit',
        target: s.name,
        sub: s.sub,
        msg: s.note ?? `${s.code_ext ? `HTTP ${s.code_ext}` : 'Probe fehlgeschlagen'} — Origin nicht erreichbar`,
        iso: s.last_incident_iso,
        actions: ['inspect'],
        onClick: () => p.onInspectService?.(s.id),
      });
    } else if (s.status === 'warn') {
      out.push({
        id: `svc-${s.id}`,
        level: 'warn',
        target: s.name,
        sub: s.sub,
        msg: s.note ?? `Externe Probe fehlgeschlagen — ${s.ms}ms`,
        iso: s.last_incident_iso,
        actions: ['inspect'],
        onClick: () => p.onInspectService?.(s.id),
      });
    }
  }
  for (const c of p.certs) {
    if (c.days_left <= 0) {
      out.push({ id: `cert-${c.domain}`, level: 'crit', target: c.domain, sub: c.issuer, msg: 'Cert abgelaufen', iso: null, actions: ['renew'] });
    } else if (c.days_left < p.certWarnDays) {
      out.push({
        id: `cert-${c.domain}`,
        level: c.days_left < 7 ? 'crit' : 'warn',
        target: c.domain,
        sub: c.issuer,
        msg: `Cert läuft in ${c.days_left} Tagen ab`,
        iso: null,
        actions: ['renew'],
      });
    }
  }
  if (p.backups && !p.backups.reachable) {
    out.push({ id: 'backup-unreach', level: 'crit', target: 'PBS', sub: 'backup', msg: p.backups.error ?? 'Datastore nicht erreichbar', iso: null, actions: ['inspect'] });
  }
  // Only a real outage counts — `reachable === false` means Cloudflare is
  // simply not configured, which is not an alert-worthy condition.
  if (p.tunnel && p.tunnel.reachable && p.tunnel.status === 'down') {
    out.push({ id: 'tunnel-down', level: 'crit', target: 'Tunnel', sub: 'cloudflare', msg: 'Cloudflare-Tunnel offline', iso: null, actions: ['inspect'] });
  } else if (p.tunnel && p.tunnel.reachable && p.tunnel.status === 'degraded') {
    out.push({ id: 'tunnel-degraded', level: 'warn', target: 'Tunnel', sub: 'cloudflare', msg: 'Cloudflare-Tunnel degraded', iso: null, actions: ['inspect'] });
  }
  // Order: crit before warn before info, then alphabetical.
  out.sort((a, b) => {
    const order = { crit: 0, warn: 1, info: 2 } as const;
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    return a.target.localeCompare(b.target);
  });
  return out;
}

export function computeHealth(alerts: Alert[]): number {
  let penalty = 0;
  for (const a of alerts) {
    if (a.id.startsWith('svc-')) penalty += a.level === 'crit' ? HEALTH_WEIGHTS.svc_err : HEALTH_WEIGHTS.svc_warn;
    else if (a.id.startsWith('ram-')) penalty += a.level === 'crit' ? HEALTH_WEIGHTS.ram_crit : HEALTH_WEIGHTS.ram_warn;
    else if (a.id.startsWith('cpu-')) penalty += HEALTH_WEIGHTS.cpu_warn;
    else if (a.id.startsWith('cert-')) penalty += a.level === 'crit' ? HEALTH_WEIGHTS.cert_crit : HEALTH_WEIGHTS.cert_warn;
    else if (a.id.startsWith('backup-')) penalty += HEALTH_WEIGHTS.backup_fail;
    else if (a.id.startsWith('tunnel-')) penalty += a.level === 'crit' ? HEALTH_WEIGHTS.tunnel_down : HEALTH_WEIGHTS.cert_warn;
  }
  return Math.max(0, 100 - penalty);
}

function AlertRow({ alert }: { alert: Alert }) {
  const color = alert.level === 'crit' ? 'var(--err)' : alert.level === 'warn' ? 'var(--warn)' : 'var(--info)';
  const icon = (
    <span className="alert-icon" style={{ color }}>
      {alert.level === 'info' ? ICONS.info : ICONS.warn}
    </span>
  );
  const body = (
    <>
      {icon}
      <span className="alert-target">
        {alert.target}
        <span className="alert-sub">{alert.sub}</span>
      </span>
      <span className="alert-msg">{alert.msg}</span>
      <span className="alert-time">{fmtTimeAgo(alert.iso)}</span>
      <span className="alert-actions">
        {alert.onClick && <span className="alert-chevron" aria-hidden="true">{ICONS.chevron}</span>}
      </span>
    </>
  );
  // Only render an interactive control when there's somewhere to go — a
  // non-actionable alert is a plain row, not a button that does nothing.
  if (alert.onClick) {
    return (
      <button type="button" className={`alert-row ${alert.level}`} onClick={alert.onClick} role="listitem">
        {body}
      </button>
    );
  }
  return (
    <div className={`alert-row alert-row-static ${alert.level}`} role="listitem">
      {body}
    </div>
  );
}

export function AttentionHero(p: Props) {
  const alerts = deriveAlerts(p);
  const crit = alerts.filter((a) => a.level === 'crit');
  const warn = alerts.filter((a) => a.level === 'warn');
  const visible = [...crit, ...warn].slice(0, 4);
  const health = computeHealth(alerts);
  const scoreClass = health < 70 ? 'err' : health < 90 ? 'warn' : '';
  const desc = crit.length > 0
    ? `${crit.length} Service${crit.length === 1 ? '' : 's'} benötigen sofortige Aufmerksamkeit.${visible[0] ? ` Beginne mit ${visible[0].target}.` : ''}`
    : warn.length > 0
      ? `${warn.length} Auffälligkeit${warn.length === 1 ? '' : 'en'} — nichts kritisches.`
      : 'Alle Systeme nominal.';

  return (
    <div className="attention">
      <div className="health-score">
        <span className="health-score-label">System Health</span>
        <div className="health-score-value">
          <span className={`health-score-num ${scoreClass}`}>{health}</span>
          <span className="health-score-out">/ 100</span>
        </div>
        {health < 100 && (
          <span className={`health-score-delta ${scoreClass || 'ok'}`}>
            {ICONS.warn}
            −{100 - health} · {crit.length} kritisch
          </span>
        )}
        <p className="health-score-desc">{desc}</p>
        <div className="health-score-meter" aria-hidden="true">
          <div style={{ width: `${health}%` }} />
          <span className="marker" style={{ left: `${health}%` }} />
        </div>
      </div>

      <div className="alerts-stack">
        <div className="alerts-stack-head">
          <span>{ICONS.bell} Active Alerts <span className="dim">· {alerts.length}</span></span>
          {alerts.length > visible.length && (
            <span className="dim mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {alerts.length - visible.length} weitere
            </span>
          )}
        </div>
        <div className="alerts-list" role="list">
          {visible.length === 0 ? (
            <div className="empty">Keine offenen Alerts — alle Systeme nominal.</div>
          ) : (
            visible.map((a) => <AlertRow key={a.id} alert={a} />)
          )}
        </div>
      </div>
    </div>
  );
}
