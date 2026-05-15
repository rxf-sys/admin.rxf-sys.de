import type { BackupSnapshot, BackupSummary, CertsSnapshot } from '../types';
import { Dot, ICONS, fmtBytes, fmtTimeAgo } from './primitives';

interface Props {
  backups: BackupSummary | null;
  certs: CertsSnapshot | null;
  /**
   * Which of the two cards to render. ``'all'`` (default) shows both side by
   * side; ``'backup'`` only PBS jobs; ``'certs'`` only the cert + DNS card.
   */
  show?: 'all' | 'backup' | 'certs';
  onVerify?: (snapshot: BackupSnapshot) => void;
}

export function BackupsCerts({ backups, certs, show = 'all', onVerify }: Props) {
  const certColor = (d: number) =>
    d < 14 ? 'var(--err)' : d < 30 ? 'var(--warn)' : 'var(--ok)';

  return (
    <section className="dash-section">
      <div className={`bc-grid bc-grid-${show}`}>
        {show !== 'certs' && (
        <div className="card">
          <div className="card-h">
            <h3>
              PBS Jobs{' '}
              <span className="dim" style={{ fontWeight: 400, textTransform: 'none' }}>
                · letzte {Math.min(backups?.jobs.length ?? 0, 10)}
              </span>
            </h3>
          </div>
          <div className="job-list">
            {(backups?.jobs ?? []).slice(0, 10).map((j) => (
              <div key={j.id} className="job-row">
                <Dot status={j.status} />
                <div className="job-target">
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{j.target}</span>
                  <span className="mono dimmer" style={{ fontSize: 11 }}>
                    {j.id}
                  </span>
                </div>
                <span className="mono dim" style={{ fontSize: 12, width: 80, textAlign: 'right' }}>
                  {fmtBytes(j.size_b)}
                </span>
                <span
                  className={`verify ${
                    j.verify === 'ok' ? 'ok' : j.verify === 'pending' ? 'warn' : 'idle'
                  }`}
                >
                  {j.verify === 'ok' && ICONS.check}
                  {j.verify === 'pending' && (
                    <span className="mono" style={{ fontSize: 10 }}>
                      ···
                    </span>
                  )}
                  {(j.verify === '—' || j.verify === 'failed') && (
                    <span className="dimmer">—</span>
                  )}
                  <span style={{ fontSize: 11, marginLeft: 4 }}>
                    {j.verify === 'ok'
                      ? 'verified'
                      : j.verify === 'pending'
                        ? 'pending'
                        : j.verify === 'failed'
                          ? 'failed'
                          : '—'}
                  </span>
                </span>
                <span className="mono dim" style={{ fontSize: 11, width: 100, textAlign: 'right' }}>
                  {fmtTimeAgo(j.when_iso)}
                </span>
                {onVerify && (
                  <button
                    className="btn icon-sm"
                    onClick={() => onVerify(j)}
                    title={
                      j.verify === 'pending'
                        ? 'Verifikation läuft / wurde angefordert'
                        : 'Verify-Job für diesen Snapshot starten'
                    }
                    aria-label={`Verify ${j.target} ${j.backup_time}`}
                    type="button"
                    disabled={j.verify === 'pending'}
                  >
                    {ICONS.check}
                  </button>
                )}
              </div>
            ))}
            {(!backups || backups.jobs.length === 0) && (
              <div className="dimmer mono" style={{ fontSize: 11, padding: 12 }}>
                Keine Backup-Daten verfügbar — PBS-Token prüfen
              </div>
            )}
          </div>
        </div>
        )}

        {show !== 'backup' && (
        <div className="card">
          <div className="card-h">
            <h3>
              SSL Certs{' '}
              <span className="dim" style={{ fontWeight: 400, textTransform: 'none' }}>
                · Cloudflare Edge
              </span>
            </h3>
          </div>
          {certs && certs.certs.length === 0 ? (
            <div className="dimmer mono" style={{ fontSize: 11, padding: 12 }}>
              Keine Zertifikate gefunden — Cloudflare-Zone-ID & API-Token prüfen
            </div>
          ) : (
            <table className="cert-table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Issuer</th>
                  <th style={{ textAlign: 'right' }}>Days left</th>
                </tr>
              </thead>
              <tbody>
                {(certs?.certs ?? []).map((c) => (
                  <tr key={`${c.domain}-${c.issuer}`}>
                    <td className="mono" style={{ fontSize: 13 }}>
                      {c.domain}
                    </td>
                    <td className="dim" style={{ fontSize: 12 }}>
                      {c.issuer}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono" style={{ color: certColor(c.days_left), fontWeight: 600 }}>
                        {c.days_left}d
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {certs && (
            <div style={{ padding: '12px 18px 18px', borderTop: '1px solid var(--border)' }}>
              <div className="dimmer" style={{ fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                DNS · CNAME → cfargotunnel.com
              </div>
              {certs.dns.length === 0 ? (
                <div className="dimmer mono" style={{ fontSize: 11 }}>
                  Keine DNS-Records — Tunnel-ID konfigurieren
                </div>
              ) : (
                <div className="job-list">
                  {certs.dns.map((d) => (
                    <div key={d.name} className="job-row" style={{ padding: '6px 0' }}>
                      <Dot status={d.ok ? 'ok' : 'err'} />
                      <span className="mono" style={{ fontSize: 12, flex: 1 }}>
                        {d.name}
                      </span>
                      <span className="mono dimmer" style={{ fontSize: 11 }}>
                        {d.type}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </section>
  );
}
