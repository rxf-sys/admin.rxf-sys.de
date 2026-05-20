import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiErrorMessage } from '../api/client';
import {
  BACKUP_INTERVALS_MS,
  CERT_INTERVALS_MS,
  CERT_WARN_DAYS,
  REFRESH_INTERVALS_MS,
  type UISettings,
} from '../hooks/useTheme';
import type { Account } from '../types';
import { ICONS } from './primitives';

type SettingsSection = 'appearance' | 'polling' | 'notifications' | 'identity' | 'about';

const MIN_PASSWORD_LEN = 8;

interface Props {
  settings: UISettings;
  update: <K extends keyof UISettings>(key: K, value: UISettings[K]) => void;
  account: Account;
  onLogout: () => void;
  onPasswordChanged: () => void;
  onError: (msg: string) => void;
  appVersion?: string;
}

const NAV: { id: SettingsSection; label: string; icon: keyof typeof ICONS }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'polling', label: 'Polling', icon: 'refresh' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'identity', label: 'Konto', icon: 'user' },
  { id: 'about', label: 'About', icon: 'info' },
];

function fmtInterval(ms: number): string {
  if (ms === 0) return 'aus';
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}min`;
  return `${ms / 3_600_000}h`;
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
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
  options: { value: T; label: string; icon?: ReactNode }[];
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
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel: string }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span />
    </label>
  );
}

function SectionHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="settings-section-h">
      <h2>{title}</h2>
      {desc && <p>{desc}</p>}
    </div>
  );
}

export function SettingsPage({
  settings,
  update,
  account,
  onLogout,
  onPasswordChanged,
  onError,
  appVersion,
}: Props) {
  const [active, setActive] = useState<SettingsSection>('appearance');
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  useEffect(() => {
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
    <>
      <div className="settings-nav-col">
        <nav className="settings-nav" aria-label="Einstellungs-Bereiche">
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
                {ICONS[n.icon] ?? null}
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="settings-content-col">
        {active === 'appearance' && (
          <div className="card">
            <SectionHead title="Appearance" desc="Visuelle Darstellung des Dashboards." />
            <Row title="Theme" desc="Wechsel zwischen hellem und dunklem Modus.">
              <Seg
                value={settings.theme}
                options={[
                  { value: 'dark', label: 'Dark', icon: ICONS.moon },
                  { value: 'light', label: 'Light', icon: ICONS.sun },
                  { value: 'auto', label: 'System', icon: ICONS.monitor },
                ]}
                onChange={(v) => update('theme', v as UISettings['theme'])}
                ariaLabel="Theme"
              />
            </Row>
            <Row title="Density" desc="Wie dicht Informationen gepackt werden.">
              <Seg
                value={settings.density}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'cozy', label: 'Cozy' },
                ]}
                onChange={(v) => update('density', v as UISettings['density'])}
                ariaLabel="Density"
              />
            </Row>
            <Row title="Sparklines" desc="Mini-Charts in Service-Kacheln anzeigen.">
              <Switch checked={settings.showSparklines} onChange={(v) => update('showSparklines', v)} ariaLabel="Sparklines anzeigen" />
            </Row>
            <Row title="Reduce motion" desc="Pulsing-Animationen für Alerts deaktivieren.">
              <Switch checked={settings.reduceMotion} onChange={(v) => update('reduceMotion', v)} ariaLabel="Animationen reduzieren" />
            </Row>
          </div>
        )}

        {active === 'polling' && (
          <div className="card">
            <SectionHead title="Polling & Auto-Refresh" desc="Wie oft das Frontend Daten vom Backend lädt." />
            <Row title="Live-Status Intervall" desc="Services, Host, Container, Tunnel.">
              <select
                className="input"
                style={{ width: 120 }}
                value={settings.refreshIntervalMs}
                onChange={(e) => update('refreshIntervalMs', Number(e.target.value))}
                aria-label="Live-Status-Intervall"
              >
                {intervalsLabel.fast.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Row>
            <Row title="Backup-Polling" desc="PBS-Daten ändern sich selten.">
              <select
                className="input"
                style={{ width: 120 }}
                value={settings.pollBackupMs}
                onChange={(e) => update('pollBackupMs', Number(e.target.value))}
                aria-label="Backup-Polling"
              >
                {intervalsLabel.backup.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Row>
            <Row title="Cert-Polling" desc="Ablaufdaten ändern sich nur täglich.">
              <select
                className="input"
                style={{ width: 120 }}
                value={settings.pollCertsMs}
                onChange={(e) => update('pollCertsMs', Number(e.target.value))}
                aria-label="Cert-Polling"
              >
                {intervalsLabel.certs.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Row>
          </div>
        )}

        {active === 'notifications' && (
          <div className="card">
            <SectionHead title="Notifications" desc="Wann Toast-Benachrichtigungen erscheinen." />
            <Row title="Status-Änderungen" desc="Toast wenn ein Service von OK → degraded → down wechselt.">
              <Switch checked={settings.notifyStatusChange} onChange={(v) => update('notifyStatusChange', v)} ariaLabel="Status-Wechsel" />
            </Row>
            <Row title="Backup-Fehler" desc="Toast bei fehlgeschlagenen PBS-Jobs.">
              <Switch checked={settings.notifyBackupFail} onChange={(v) => update('notifyBackupFail', v)} ariaLabel="Backup-Fehler" />
            </Row>
            <Row title="Cert-Warnungen" desc="Toast wenn ein Cert in weniger als N Tagen abläuft.">
              <select
                className="input"
                style={{ width: 100 }}
                value={settings.certWarnDays}
                onChange={(e) => update('certWarnDays', Number(e.target.value) as UISettings['certWarnDays'])}
                aria-label="Cert-Warn-Schwelle"
              >
                {CERT_WARN_DAYS.map((d) => (
                  <option key={d} value={d}>{d === 0 ? 'Aus' : `${d} Tage`}</option>
                ))}
              </select>
            </Row>
            <Row
              title="Browser-Notifications"
              desc={
                notifPerm === 'unsupported'
                  ? 'Browser unterstützt keine Notifications.'
                  : notifPerm === 'granted'
                    ? 'Erlaubt.'
                    : notifPerm === 'denied'
                      ? 'Verweigert — im Browser freigeben.'
                      : 'Native OS-Benachrichtigungen für kritische Alerts.'
              }
            >
              <button
                type="button"
                className="btn"
                disabled={notifPerm === 'unsupported' || notifPerm === 'granted' || notifPerm === 'denied'}
                onClick={requestBrowserNotifs}
              >
                {ICONS.bell}
                {notifPerm === 'granted' ? 'Erlaubt' : notifPerm === 'denied' ? 'Verweigert' : 'Berechtigung anfordern'}
              </button>
            </Row>
          </div>
        )}

        {active === 'identity' && (
          <>
            <div className="card">
              <SectionHead title="Konto" desc="Dein angemeldetes Konto in diesem Dashboard." />
              <Row title="Benutzername">
                <span className="mono">{account.username}</span>
              </Row>
              <Row title="E-Mail">
                <span className="mono">{account.email || '—'}</span>
              </Row>
              <Row title="Rolle" desc="Admins können Konten verwalten.">
                <span className={`role-pill ${account.role}`}>{account.role}</span>
              </Row>
              <Row title="Abmelden" desc="Beendet die aktuelle Sitzung.">
                <button type="button" className="btn danger" onClick={onLogout}>Logout</button>
              </Row>
            </div>
            <div className="card">
              <SectionHead title="Passwort ändern" desc={`Mindestens ${MIN_PASSWORD_LEN} Zeichen.`} />
              <PasswordChangeForm onChanged={onPasswordChanged} onError={onError} />
            </div>
          </>
        )}

        {active === 'about' && (
          <div className="card">
            <SectionHead title="About" />
            <div className="kv-stack">
              <div className="kv-row"><span className="kv-k">Version</span><span className="kv-v mono">{appVersion ?? 'dev'}</span></div>
              <div className="kv-row"><span className="kv-k">Backend</span><span className="kv-v mono">FastAPI · Python 3.11+</span></div>
              <div className="kv-row"><span className="kv-k">Frontend</span><span className="kv-v mono">React 19 · Vite 8 · TypeScript 6</span></div>
              <div className="kv-row"><span className="kv-k">OpenAPI</span><a className="kv-v mono" style={{ color: 'var(--accent)' }} href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a></div>
              <div className="kv-row"><span className="kv-k">Repository</span><a className="kv-v mono" style={{ color: 'var(--accent)' }} href="https://github.com/rxf-sys/admin.rxf-sys.de" target="_blank" rel="noreferrer">github.com/rxf-sys/admin.rxf-sys.de</a></div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function PasswordChangeForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (next.length < MIN_PASSWORD_LEN) {
      onError(`Neues Passwort muss mindestens ${MIN_PASSWORD_LEN} Zeichen haben`);
      return;
    }
    if (next !== confirm) {
      onError('Die neuen Passwörter stimmen nicht überein');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
    } catch (err) {
      onError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label className="login-field">
        <span>Aktuelles Passwort</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="login-field">
        <span>Neues Passwort</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label className="login-field">
        <span>Neues Passwort bestätigen</span>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <button className="btn primary" type="submit" disabled={busy} style={{ alignSelf: 'flex-start', height: 36 }}>
        {busy ? 'Speichern…' : 'Passwort ändern'}
      </button>
    </form>
  );
}
