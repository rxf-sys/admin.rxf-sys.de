import { useMemo } from 'react';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { CertsSnapshot, ServiceStatus, TunnelStatus } from '../types';
import { Dot, ICONS, Num, fmtTimeAgo } from './primitives';

interface Props {
  tunnel: TunnelStatus | null;
  certs: CertsSnapshot | null;
  services: ServiceStatus[];
  zoneName: string;
  onSelectService?: (id: string) => void;
  /** Poll interval in ms; 0 pauses (mirrors the global pause switch). */
  pollMs: number;
}

export function CloudflareSection({ tunnel, certs, services, zoneName, onSelectService, pollMs }: Props) {
  const sessions = usePoll((sig) => api.cfAccessSessions(24, sig), pollMs).data;

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

  const tunnelStatus =
    tunnel?.status === 'healthy' ? 'ok' : tunnel?.status === 'degraded' ? 'warn' : tunnel?.status === 'down' ? 'err' : 'idle';

  // Distinct accounts seen across the 24h access-log window.
  const uniqueUsers = useMemo(
    () => new Set((sessions?.items ?? []).map((i) => i.email).filter(Boolean)).size,
    [sessions],
  );

  return (
    <section className="cloudflare-section" aria-labelledby="cloudflare-heading">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2 id="cloudflare-heading">Cloudflare</h2>
      </div>

      <div className="grid-12" style={{ marginBottom: 16 }}>
        {/* Tunnel */}
        <div className="card col-5">
          <div className="card-h">
            <h3>Cloudflare Tunnel</h3>
            <span className={`badge ${tunnelStatus}`}>
              <Dot status={tunnelStatus} /> {tunnel?.status?.toUpperCase() ?? 'UNKNOWN'}
            </span>
          </div>
          <div style={{ marginBottom: 14 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {tunnel?.name ?? '—'}
            </span>
          </div>
          <div className="kv-stack">
            <div className="kv-row">
              <span className="kv-k">Connections</span>
              <Num value={tunnel?.connections ?? 0} unit="active" size="md" />
            </div>
            <div className="kv-row">
              <span className="kv-k">Edge regions</span>
              <span className="kv-v mono" style={{ fontSize: 12 }}>
                {tunnel?.regions?.length ? tunnel.regions.join(' · ') : '—'}
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-k">WAN-IP</span>
              <span className="kv-v mono">{tunnel?.wan_ip ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-k">cloudflared</span>
              <span className="kv-v mono">{tunnel?.cloudflared_version ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-k">Tunnel-ID</span>
              <span className="kv-v mono" style={{ fontSize: 11 }} title={tunnel?.id ?? ''}>
                {tunnel?.id ? `${tunnel.id.slice(0, 16)}…` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Access */}
        <div className="card col-7">
          <div className="card-h">
            <h3>Cloudflare Access <span className="h3-sub">· Zero Trust Application</span></h3>
            <span className={`badge ${sessions?.reachable === false ? 'warn' : 'info'}`}>
              <Dot status={sessions?.reachable === false ? 'warn' : 'ok'} />
              {sessions?.reachable === false ? 'NO ACCESS-LOG' : 'EMAIL OTP'}
            </span>
          </div>
          {sessions === null ? (
            <div className="dim" style={{ fontSize: 12 }}>Lade Access-Sessions…</div>
          ) : !sessions.reachable ? (
            <>
              <div className="dim" style={{ fontSize: 12, lineHeight: 1.55 }}>
                {sessions.error ?? 'Access-Audit-Log nicht erreichbar.'}
              </div>
              <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
                Hinweis: der <code>CF_API_TOKEN</code> braucht &ldquo;Access: Apps and Policies — Read&rdquo;
                auf Account-Ebene, damit das Audit-Log lesbar ist.
              </div>
            </>
          ) : (
            <div className="kv-stack">
              <div className="kv-row">
                <span className="kv-k">App</span>
                <span className="kv-v mono">{window.location.hostname}</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">Policy</span>
                <span className="kv-v">
                  Email-OTP{uniqueUsers > 0 && ` · ${uniqueUsers} ${uniqueUsers === 1 ? 'user' : 'users'}`}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-k">Letzter Login</span>
                <span className="kv-v mono">{sessions.last_login_iso ? fmtTimeAgo(sessions.last_login_iso) : '—'}</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">Letzter Benutzer</span>
                <span className="kv-v mono" style={{ fontSize: 12 }}>{sessions.items[0]?.email ?? '—'}</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">Sessions · 24h</span>
                <Num value={sessions.sessions_24h} size="md" />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid-12">
        {/* SSL certs */}
        <div className="card col-6">
          <div className="card-h">
            <h3>SSL Certs <span className="h3-sub">· Cloudflare Edge + Origin</span></h3>
          </div>
          {!certs ? (
            <div className="dim" style={{ fontSize: 12 }}>Lade…</div>
          ) : certs.reachable === false ? (
            <div className="dim" style={{ fontSize: 12, color: 'var(--err)' }}>
              {certs.error ?? 'Cloudflare-API nicht erreichbar.'}
            </div>
          ) : certs.certs.length === 0 ? (
            <div className="dim mono" style={{ fontSize: 11 }}>
              Keine Zertifikate in der Zone gefunden.
            </div>
          ) : (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Issuer</th>
                  <th style={{ textAlign: 'right' }}>Days left</th>
                </tr>
              </thead>
              <tbody>
                {certs.certs.map((c) => {
                  const color = c.days_left < 14 ? 'var(--err)' : c.days_left < 30 ? 'var(--warn)' : 'var(--ok)';
                  return (
                    <tr key={`${c.domain}-${c.issuer}`}>
                      <td className="mono" style={{ fontSize: 12.5 }}>{c.domain}</td>
                      <td className="dim" style={{ fontSize: 12 }}>{c.issuer}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="mono" style={{ color, fontWeight: 600 }}>{c.days_left}d</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* DNS records */}
        <div className="card col-6">
          <div className="card-h">
            <h3>DNS Records <span className="h3-sub">· {dnsStatuses.length} hostnames</span></h3>
            <a
              className="btn sm"
              href="https://dash.cloudflare.com/"
              target="_blank"
              rel="noreferrer"
              title={`DNS-Zone ${zoneName} im Cloudflare-Dashboard`}
            >
              {ICONS.ext} Manage on Cloudflare
            </a>
          </div>
          {dnsStatuses.length === 0 ? (
            <div className="dim mono" style={{ fontSize: 11 }}>
              Keine DNS-Records — Tunnel-ID konfigurieren.
            </div>
          ) : (
            <div className="dns-list">
              {dnsStatuses.map((r) => {
                const clickable = !!(onSelectService && r.svc);
                const onRowClick = clickable ? () => onSelectService!(r.svc!.id) : undefined;
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
                    aria-label={onRowClick ? `Service-Details für ${r.name} öffnen` : undefined}
                  >
                    <Dot status={r.status} />
                    <span className="mono" style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>{r.name}</span>
                    <span className="type-pill type-lxc" style={{ fontSize: 9 }}>{r.type}</span>
                    <span className="mono dimmer" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
                      → {r.content.endsWith('cfargotunnel.com') ? 'cfargotunnel.com' : r.content}
                    </span>
                    {r.svc?.ext && r.svc?.internal && (
                      <span className="badge info" style={{ fontSize: 9, padding: '1px 6px' }}>PROXIED</span>
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
