import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type {
  AccessSessions,
  CertsSnapshot,
  ServiceStatus,
  TunnelStatus,
} from '../types';
import { Dot, ICONS, fmtTimeAgo } from './primitives';

interface Props {
  tunnel: TunnelStatus | null;
  certs: CertsSnapshot | null;
  services: ServiceStatus[];
  zoneName: string;
  onSelectService?: (id: string) => void;
}

export function CloudflareSection({
  tunnel,
  certs,
  services,
  zoneName,
  onSelectService,
}: Props) {
  const [sessions, setSessions] = useState<AccessSessions | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .cfAccessSessions(24, ctrl.signal)
      .then(setSessions)
      .catch(() => {
        /* leave null */
      });
    return () => ctrl.abort();
  }, []);

  // DNS-Record-Status: cross-reference each DNS hostname with the matching
  // service probe so the dot mirrors the Services-Grid for the same host.
  const dnsStatuses = useMemo(() => {
    const byHost = new Map<string, ServiceStatus>();
    services.forEach((s) => byHost.set(s.sub, s));
    return (certs?.dns ?? []).map((r) => {
      const svc = byHost.get(r.name);
      let status: 'ok' | 'warn' | 'err' = 'ok';
      if (!r.ok) status = 'err';
      else if (svc) status = svc.status === 'idle' ? 'ok' : svc.status;
      return { ...r, status, svc };
    });
  }, [certs, services]);

  return (
    <section className="dash-section" aria-labelledby="cloudflare-heading">
      <h2 id="cloudflare-heading" className="dimmer mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 12px' }}>
        Cloudflare
      </h2>

      <div className="grid-12" style={{ marginBottom: 14 }}>
        <div className="col-5 card">
          <div className="card-h">
            <h3>Cloudflare Tunnel</h3>
            <span
              className={`badge ${
                tunnel?.status === 'healthy'
                  ? 'ok'
                  : tunnel?.status === 'degraded'
                    ? 'warn'
                    : tunnel?.status === 'down'
                      ? 'err'
                      : ''
              }`}
            >
              {tunnel?.status?.toUpperCase() ?? '—'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
            <span
              className="mono"
              style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-1)' }}
            >
              {tunnel?.connections ?? 0}
            </span>
            <span className="dim" style={{ fontSize: 12 }}>
              aktive Verbindung{tunnel?.connections === 1 ? '' : 'en'}
            </span>
          </div>
          <div className="ov-rows">
            <div className="ov-row">
              <span className="dim">Tunnel-ID</span>
              <span className="mono" style={{ fontSize: 11 }} title={tunnel?.id ?? ''}>
                {tunnel?.id ? `${tunnel.id.slice(0, 12)}…` : '—'}
              </span>
            </div>
            <div className="ov-row">
              <span className="dim">Edge regions</span>
              <span className="mono" style={{ fontSize: 12 }}>
                {tunnel?.regions?.length ? tunnel.regions.join(', ') : '—'}
              </span>
            </div>
            <div className="ov-row">
              <span className="dim">WAN IP</span>
              <span className="mono" style={{ fontSize: 12 }}>
                {tunnel?.wan_ip ?? '—'}
              </span>
            </div>
            <div className="ov-row">
              <span className="dim">cloudflared</span>
              <span className="mono" style={{ fontSize: 12 }}>
                {tunnel?.cloudflared_version ?? '—'}
              </span>
            </div>
          </div>
        </div>

        <div className="col-7 card">
          <div className="card-h">
            <h3>Cloudflare Access</h3>
            <span
              className={`badge ${sessions?.reachable === false ? 'warn' : 'ok'}`}
            >
              {sessions?.reachable === false ? 'NO ACCESS-LOG' : 'AUDIT OK'}
            </span>
          </div>
          {sessions === null ? (
            <div className="dimmer" style={{ fontSize: 12 }}>
              Lade Access-Sessions…
            </div>
          ) : !sessions.reachable ? (
            <>
              <div className="dimmer" style={{ fontSize: 12, lineHeight: 1.55 }}>
                {sessions.error ?? 'Access-Audit-Log nicht erreichbar.'}
              </div>
              <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
                Hinweis: der <code>CF_API_TOKEN</code> braucht &ldquo;Access: Apps and Policies — Read&rdquo;
                auf Account-Ebene, damit das Audit-Log lesbar ist.
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
                <span
                  className="mono"
                  style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-1)' }}
                >
                  {sessions.sessions_24h}
                </span>
                <span className="dim" style={{ fontSize: 12 }}>
                  Sessions · 24h
                </span>
              </div>
              <div className="ov-rows">
                <div className="ov-row">
                  <span className="dim">Letzter Login</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {sessions.last_login_iso ? fmtTimeAgo(sessions.last_login_iso) : '—'}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">Letzter Benutzer</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {sessions.items[0]?.email ?? '—'}
                  </span>
                </div>
                <div className="ov-row">
                  <span className="dim">Letzte IP</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {sessions.items[0]?.ip ?? '—'} {sessions.items[0]?.country ? `· ${sessions.items[0].country}` : ''}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid-12">
        <div className="col-6 card">
          <div className="card-h">
            <h3>SSL Certs</h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              Cloudflare Edge · Zone {zoneName}
            </span>
          </div>
          {!certs ? (
            <div className="dimmer" style={{ fontSize: 12 }}>
              Lade…
            </div>
          ) : certs.certs.length === 0 ? (
            <div className="dimmer mono" style={{ fontSize: 11 }}>
              Keine Zertifikate gefunden — Cloudflare-Zone-ID & API-Token prüfen.
            </div>
          ) : (
            <table className="cert-table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Issuer</th>
                  <th style={{ textAlign: 'center' }}>Auto</th>
                  <th style={{ textAlign: 'right' }}>Days left</th>
                </tr>
              </thead>
              <tbody>
                {certs.certs.map((c) => {
                  const color =
                    c.days_left < 14
                      ? 'var(--err)'
                      : c.days_left < 30
                        ? 'var(--warn)'
                        : 'var(--ok)';
                  // Cloudflare Edge certs are always auto-renewed; surface the
                  // checkmark inline so the column carries weight visually.
                  return (
                    <tr key={`${c.domain}-${c.issuer}`}>
                      <td className="mono" style={{ fontSize: 13 }}>
                        <a
                          className="drawer-link"
                          href={`https://dash.cloudflare.com/?to=/:account/${zoneName}/ssl-tls/edge-certificates`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {c.domain}
                        </a>
                      </td>
                      <td className="dim" style={{ fontSize: 12 }}>
                        {c.issuer}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--ok)' }}>
                        {ICONS.check}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="mono" style={{ color, fontWeight: 600 }}>
                          {c.days_left}d
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="col-6 card">
          <div className="card-h">
            <h3>DNS Records</h3>
            <span className="dimmer mono" style={{ fontSize: 11 }}>
              {dnsStatuses.length} Records · CNAME → cfargotunnel
            </span>
          </div>
          {dnsStatuses.length === 0 ? (
            <div className="dimmer mono" style={{ fontSize: 11 }}>
              Keine DNS-Records — Tunnel-ID konfigurieren.
            </div>
          ) : (
            <div className="dns-list">
              {dnsStatuses.map((r) => {
                const clickable = !!(onSelectService && r.svc);
                const onRowClick = clickable
                  ? () => onSelectService!(r.svc!.id)
                  : undefined;
                return (
                  <div
                    key={r.name}
                    className="dns-row"
                    onClick={onRowClick}
                    role={onRowClick ? 'button' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick();
                            }
                          }
                        : undefined
                    }
                    style={onRowClick ? { cursor: 'pointer' } : undefined}
                    aria-label={
                      onRowClick ? `Service-Details für ${r.name} öffnen` : undefined
                    }
                  >
                    <Dot status={r.status} />
                    <span className="mono" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                      {r.name}
                    </span>
                    <span
                      className="type-pill"
                      style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}
                    >
                      {r.type}
                    </span>
                    <span className="mono dim" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                      → {r.content.endsWith('cfargotunnel.com') ? 'cfargotunnel.com' : r.content}
                    </span>
                    {r.svc?.ext && r.svc?.internal && (
                      <span className="badge ok" style={{ fontSize: 9, padding: '1px 6px' }}>
                        PROXIED
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
