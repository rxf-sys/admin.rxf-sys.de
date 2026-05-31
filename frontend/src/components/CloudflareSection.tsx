import { useMemo } from 'react';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { CertsSnapshot, ServiceStatus, TunnelStatus } from '../types';
import { Dot, ICONS, Num, Sparkline } from './primitives';

interface Props {
  tunnel: TunnelStatus | null;
  certs: CertsSnapshot | null;
  services: ServiceStatus[];
  zoneName: string;
  onSelectService?: (id: string) => void;
  /** Poll interval in ms for analytics; 0 pauses. */
  pollMs: number;
}

export function CloudflareSection({ tunnel, certs, services, zoneName, onSelectService, pollMs }: Props) {
  // Analytics refresh on the slower 'certs' tier — CF aggregates per minute,
  // there's no value in polling it every few seconds.
  const analytics = usePoll((sig) => api.cfAnalytics(60, sig), pollMs).data;

  const dnsStatuses = useMemo(() => {
    // Tunnel records get the matching service's live status; everything else
    // (MX / TXT / non-proxied A) gets an idle dot — those rows are
    // informational, not actively probed.
    const byHost = new Map<string, ServiceStatus>();
    services.forEach((s) => byHost.set(s.sub, s));
    return (certs?.dns ?? []).map((r) => {
      const isTunnel = r.content.endsWith('cfargotunnel.com');
      const svc = byHost.get(r.name);
      let status: 'ok' | 'warn' | 'err' | 'idle';
      if (!r.ok) status = 'err';
      else if (isTunnel && svc) status = svc.status === 'idle' ? 'ok' : svc.status;
      else if (isTunnel) status = 'ok';
      else status = 'idle';
      return { ...r, status, svc, isTunnel };
    });
  }, [certs, services]);

  const tunnelStatus =
    tunnel?.status === 'healthy' ? 'ok' : tunnel?.status === 'degraded' ? 'warn' : tunnel?.status === 'down' ? 'err' : 'idle';

  return (
    <section className="cloudflare-section" aria-labelledby="cloudflare-heading">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2 id="cloudflare-heading">Cloudflare</h2>
      </div>

      <div className="grid-12" style={{ marginBottom: 16 }}>
        {/* Tunnel */}
        <div className="card col-5">
          <div className="card-h">
            <h3>Tunnel {tunnel?.name && <span className="h3-sub">· {tunnel.name}</span>}</h3>
            <span className={`badge ${tunnelStatus}`}>
              <Dot status={tunnelStatus} /> {tunnel?.status?.toUpperCase() ?? 'UNKNOWN'}
            </span>
          </div>
          <div className="kv-stack">
            <div className="kv-row">
              <span className="kv-k">Verbindungen</span>
              <Num value={tunnel?.connections ?? 0} unit="aktiv" size="md" />
            </div>
            <div className="kv-row">
              <span className="kv-k">Regionen</span>
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

        {/* Requests / Edge analytics */}
        <RequestsCard
          analytics={analytics}
          edgePops={tunnel?.regions?.length ?? null}
        />
      </div>

      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Zertifikate &amp; DNS</h3>
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
            <div className="cert-list">
              {certs.certs.map((c) => {
                const color = c.days_left < 14 ? 'var(--err)' : c.days_left < 30 ? 'var(--warn)' : 'var(--ok)';
                // 90 days = full bar; clamped so a fresh 90+ day cert still
                // tops out at 100% and very-soon-expiring stays visible.
                const pct = Math.max(4, Math.min(100, (c.days_left / 90) * 100));
                return (
                  <div key={`${c.domain}-${c.issuer}`} className="cert-row">
                    <span className="mono cert-domain" style={{ fontSize: 12.5 }}>{c.domain}</span>
                    <span className="dim cert-issuer" style={{ fontSize: 11.5 }}>{c.issuer}</span>
                    <span className="cert-bar">
                      <span style={{ width: `${pct}%`, background: color }} />
                    </span>
                    <span className="mono cert-days" style={{ color, fontWeight: 600 }}>{c.days_left}d</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* DNS records */}
        <div className="card col-6">
          <div className="card-h">
            <h3>DNS Records <span className="h3-sub">· {dnsStatuses.length} Einträge</span></h3>
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
              Keine DNS-Records in der Zone — CF_ZONE_ID prüfen.
            </div>
          ) : (
            <div className="dns-list">
              {dnsStatuses.map((r) => {
                const clickable = !!(onSelectService && r.svc);
                const onRowClick = clickable ? () => onSelectService!(r.svc!.id) : undefined;
                // Unique key — a zone can have multiple records sharing a name
                // (TXT, MX, SPF, …); name alone would collide in React.
                const rowKey = `${r.name}|${r.type}|${r.content}`;
                return (
                  <div
                    key={rowKey}
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

function RequestsCard({
  analytics,
  edgePops,
}: {
  analytics: import('../types').CloudflareAnalytics | null;
  edgePops: number | null;
}) {
  // Format a per-minute count compactly: 1234 -> "1.2k", 78 -> "78".
  const fmtPerMin = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    if (n >= 100) return Math.round(n).toString();
    return n.toFixed(1);
  };
  const reqPerMin = analytics?.requests_per_min ?? 0;
  const series = (analytics?.series ?? []).map((b) => b.all);
  const ok = analytics?.reachable !== false;
  return (
    <div className="card col-7">
      <div className="card-h">
        <h3>Requests <span className="h3-sub">· letzte Stunde</span></h3>
        <span className={`badge ${ok ? 'ok' : 'warn'}`}>
          <Dot status={ok ? 'ok' : 'warn'} /> {ok ? 'LIVE' : 'NO ANALYTICS'}
        </span>
      </div>
      {analytics === null ? (
        <div className="dim" style={{ fontSize: 12 }}>Lade Analytics…</div>
      ) : !analytics.reachable ? (
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.55 }}>
          {analytics.error ?? 'Cloudflare Analytics nicht erreichbar.'}
          <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
            Hinweis: der <code>CF_API_TOKEN</code> braucht &ldquo;Zone &middot; Analytics: Read&rdquo; für diese Zone.
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 10 }}>
            <div>
              <span className="mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px', color: 'var(--text-1)' }}>
                {fmtPerMin(reqPerMin)}
              </span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 6 }}>req/min</span>
            </div>
            <Sparkline data={series} width={220} height={42} area color="var(--accent)" />
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
            <span className="mono dim">Cache-Hit {analytics.cache_hit_pct == null ? '—' : `${analytics.cache_hit_pct.toFixed(1)}%`}</span>
            <span className="mono dim">{analytics.threats_total} {analytics.threats_total === 1 ? 'Threat' : 'Threats'}</span>
            <span className="mono dim">Edge: {edgePops ?? '?'} PoPs</span>
            <span className="mono dim" style={{ marginLeft: 'auto' }}>{analytics.requests_total.toLocaleString('de-DE')} req · 60 min</span>
          </div>
        </>
      )}
    </div>
  );
}
