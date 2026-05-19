import { useEffect, useMemo, useState } from 'react';
import {
  BACKUP_INTERVALS_MS,
  CERT_INTERVALS_MS,
  CERT_WARN_DAYS,
  REFRESH_INTERVALS_MS,
  type UISettings,
} from '../hooks/useTheme';
import { ICONS } from './primitives';

type SettingsSection =
  | 'appearance'
  | 'polling'
  | 'notifications'
  | 'identity'
  | 'about';

interface Props {
  settings: UISettings;
  update: <K extends keyof UISettings>(key: K, value: UISettings[K]) => void;
  email: string | null;
  identitySession?: { iat?: number | null; exp?: number | null } | null;
  onLogout?: () => void;
  appVersion?: string;
}

const NAV: { id: SettingsSection; label: string; icon: keyof typeof ICONS }[] = [
  { id: 'appearance', label: 'Erscheinungsbild', icon: 'palette' },
  { id: 'polling', label: 'Polling', icon: 'refresh' },
  { id: 'notifications', label: 'Benachrichtigungen', icon: 'bell' },
  { id: 'identity', label: 'Identität', icon: 'user' },
  { id: 'about', label: 'Über', icon: 'info' },
];

function fmtInterval(ms: number): string {
  if (ms === 0) return 'aus';
  if (ms < 60_000) return `${ms / 1000} s`;
  if (ms < 3_600_000) return `${ms / 60_000} min`;
  return `${ms / 3_600_000} h`;
}

function fmtSessionExp(exp: number | null | undefined): string {
  if (!exp) return '—';
  const date = new Date(exp * 1000);
  const diffMin = Math.round((date.getTime() - Date.now()) / 60_000);
  if (diffMin <= 0) return 'abgelaufen';
  if (diffMin < 60) return `läuft in ${diffMin} min ab`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `läuft in ${h}h ${m}m ab (${date.toLocaleString()})`;
}

interface RowProps {
  title: string;
  desc?: string;
  children: React.ReactNode;
}
function Row({ title, desc, children }: RowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h4>{title}</h4>
        {desc && <p>{desc}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

interface SegProps<T extends string | number> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}
function Seg<T extends string | number>({ value, options, onChange, ariaLabel }: SegProps<T>) {
  return (
    <div className="seg-control" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`seg-btn ${o.value === value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function SettingsPage({
  settings,
  update,
  email,
  identitySession,
  onLogout,
  appVersion,
}: Props) {
  const [active, setActive] = useState<SettingsSection>('appearance');
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  useEffect(() => {
    // re-poll permission state when the user comes back from the browser prompt
    if (notifPerm === 'unsupported') return;
    const onFocus = () => setNotifPerm(Notification.permission);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [notifPerm]);

  const requestBrowserNotifs = async () => {
    if (notifPerm === 'unsupported' || notifPerm === 'granted') return;
    try {
      const p = await Notification.requestPermission();
      setNotifPerm(p);
    } catch {
      // ignore
    }
  };

  const intervalsLabel = useMemo(
    () => ({
      fast: REFRESH_INTERVALS_MS.map((ms) => ({ value: ms, label: fmtInterval(ms) })),
      backup: BACKUP_INTERVALS_MS.map((ms) => ({ value: ms, label: fmtInterval(ms) })),
      certs: CERT_INTERVALS_MS.map((ms) => ({ value: ms, label: fmtInterval(ms) })),
    }),
    [],
  );

  return (
    <div className="settings-page" id="section-settings" role="tabpanel" aria-label="Einstellungen">
      <aside className="settings-nav" aria-label="Einstellungs-Bereiche">
        {NAV.map((n) => {
          const isActive = n.id === active;
          return (
            <button
              key={n.id}
              type="button"
              className={`settings-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => setActive(n.id)}
              aria-current={isActive ? 'true' : undefined}
            >
              <span className="settings-nav-icon" aria-hidden="true">
                {ICONS[n.icon] ?? '·'}
              </span>
              <span>{n.label}</span>
            </button>
          );
        })}
      </aside>
      <div className="settings-panes">
        {active === 'appearance' && (
          <section className="card">
            <h3 className="settings-section-h">Erscheinungsbild</h3>
            <Row title="Theme" desc="Wähle das Farbschema oder folge den Systemeinstellungen.">
              <Seg
                value={settings.theme}
                options={[
                  { value: 'dark', label: 'Dunkel' },
                  { value: 'light', label: 'Hell' },
                  { value: 'auto', label: 'System' },
                ]}
                onChange={(v) => update('theme', v as UISettings['theme'])}
                ariaLabel="Theme"
              />
            </Row>
            <Row title="Dichte" desc="Compact spart Platz, Cozy gibt den Karten mehr Luft.">
              <Seg
                value={settings.density}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'cozy', label: 'Cozy' },
                ]}
                onChange={(v) => update('density', v as UISettings['density'])}
                ariaLabel="Dichte"
              />
            </Row>
            <Row title="Sparklines anzeigen" desc="Kleine Verlaufsgrafiken in Service-Kacheln.">
              <Switch
                checked={settings.showSparklines}
                onChange={(v) => update('showSparklines', v)}
                ariaLabel="Sparklines anzeigen"
              />
            </Row>
            <Row title="Animationen reduzieren" desc="Deaktiviert Pulse-, Shimmer- und Slide-In-Effekte.">
              <Switch
                checked={settings.reduceMotion}
                onChange={(v) => update('reduceMotion', v)}
                ariaLabel="Animationen reduzieren"
              />
            </Row>
          </section>
        )}

        {active === 'polling' && (
          <section className="card">
            <h3 className="settings-section-h">Polling-Intervalle</h3>
            <Row
              title="Live-Status"
              desc="Services, System-Auslastung, Tunnel, Netzwerk. Niedriger = mehr Last."
            >
              <Seg
                value={settings.refreshIntervalMs}
                options={intervalsLabel.fast}
                onChange={(v) => update('refreshIntervalMs', v as number)}
                ariaLabel="Live-Status-Intervall"
              />
            </Row>
            <Row title="Backup-Übersicht" desc="PBS-Snapshots, Datastore-Auslastung.">
              <Seg
                value={settings.pollBackupMs}
                options={intervalsLabel.backup}
                onChange={(v) => update('pollBackupMs', v as number)}
                ariaLabel="Backup-Polling-Intervall"
              />
            </Row>
            <Row title="SSL-Zertifikate" desc="Ändern sich selten; lange Intervalle sparen API-Calls.">
              <Seg
                value={settings.pollCertsMs}
                options={intervalsLabel.certs}
                onChange={(v) => update('pollCertsMs', v as number)}
                ariaLabel="Cert-Polling-Intervall"
              />
            </Row>
          </section>
        )}

        {active === 'notifications' && (
          <section className="card">
            <h3 className="settings-section-h">Benachrichtigungen</h3>
            <Row
              title="Status-Wechsel"
              desc="Toast anzeigen, wenn ein Service in einen anderen Status wechselt."
            >
              <Switch
                checked={settings.notifyStatusChange}
                onChange={(v) => update('notifyStatusChange', v)}
                ariaLabel="Status-Wechsel-Toast"
              />
            </Row>
            <Row
              title="Backup-Fehler"
              desc="Toast anzeigen, wenn ein PBS-Job fehlschlägt."
            >
              <Switch
                checked={settings.notifyBackupFail}
                onChange={(v) => update('notifyBackupFail', v)}
                ariaLabel="Backup-Fehler-Toast"
              />
            </Row>
            <Row
              title="Cert-Warnung ab"
              desc="Toast/Pill wenn ein Zertifikat in weniger als N Tagen abläuft."
            >
              <Seg
                value={settings.certWarnDays}
                options={CERT_WARN_DAYS.map((d) => ({
                  value: d,
                  label: d === 0 ? 'aus' : `${d} Tage`,
                }))}
                onChange={(v) => update('certWarnDays', v as UISettings['certWarnDays'])}
                ariaLabel="Cert-Warn-Schwelle"
              />
            </Row>
            <Row
              title="Browser-Benachrichtigungen"
              desc={
                notifPerm === 'unsupported'
                  ? 'Browser unterstützt keine Notifications.'
                  : notifPerm === 'granted'
                    ? 'Erlaubt — Toasts werden zusätzlich als System-Notification gezeigt (sofern aktiv).'
                    : notifPerm === 'denied'
                      ? 'Verweigert — im Browser-Site-Setting freigeben.'
                      : 'Aktivieren, um Toasts auch außerhalb des Tabs zu sehen.'
              }
            >
              <button
                type="button"
                className="btn"
                disabled={notifPerm === 'unsupported' || notifPerm === 'granted' || notifPerm === 'denied'}
                onClick={requestBrowserNotifs}
              >
                {notifPerm === 'granted' ? 'Erlaubt' : notifPerm === 'denied' ? 'Verweigert' : 'Aktivieren'}
              </button>
            </Row>
          </section>
        )}

        {active === 'identity' && (
          <section className="card">
            <h3 className="settings-section-h">Identität</h3>
            <Row title="E-Mail" desc="Aus dem Cloudflare-Access-JWT.">
              <span className="mono" style={{ fontSize: 13 }}>{email ?? '—'}</span>
            </Row>
            <Row title="Session" desc="Gültigkeit des Cloudflare-Access-Tokens.">
              <span className="mono" style={{ fontSize: 13 }}>
                {fmtSessionExp(identitySession?.exp ?? null)}
              </span>
            </Row>
            <Row title="Abmelden" desc="Beendet die Cloudflare-Access-Session.">
              <button type="button" className="btn danger" onClick={onLogout}>
                Logout
              </button>
            </Row>
          </section>
        )}

        {active === 'about' && (
          <section className="card">
            <h3 className="settings-section-h">Über diese Instanz</h3>
            <Row title="Version" desc="Stand des Frontends.">
              <span className="mono" style={{ fontSize: 13 }}>{appVersion ?? 'dev'}</span>
            </Row>
            <Row title="Backend" desc="FastAPI · Python 3.12.">
              <span className="mono" style={{ fontSize: 13 }}>FastAPI / httpx / SQLite</span>
            </Row>
            <Row title="Frontend" desc="React · TypeScript · Vite.">
              <span className="mono" style={{ fontSize: 13 }}>React 18 / TS 5 / Vite 5</span>
            </Row>
            <Row title="API-Docs" desc="OpenAPI-Schema des Backends.">
              <a className="btn" href="/api/docs" target="_blank" rel="noreferrer">
                /api/docs
              </a>
            </Row>
            <Row title="Repository" desc="Quellcode auf GitHub.">
              <a
                className="btn"
                href="https://github.com/rxf-sys/admin.rxf-sys.de"
                target="_blank"
                rel="noreferrer"
              >
                rxf-sys/admin.rxf-sys.de
              </a>
            </Row>
          </section>
        )}
      </div>
    </div>
  );
}
