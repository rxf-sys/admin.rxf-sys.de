import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiErrorMessage } from '../api/client';
import {
  BACKUP_INTERVALS_MS,
  CERT_INTERVALS_MS,
  CERT_WARN_DAYS,
  REFRESH_INTERVALS_MS,
  type UISettings,
} from '../hooks/useTheme';
import type { Account, BackupSummary, InstanceInfo, NetworkSnapshot, NtfyConfig, ReportConfig, SmtpConfig, SystemSnapshot, TotpSetup, TotpStatus, TunnelStatus } from '../types';
import { Dot, ICONS } from './primitives';

const MIN_PASSWORD_LEN = 8;

interface Props {
  settings: UISettings;
  update: <K extends keyof UISettings>(key: K, value: UISettings[K]) => void;
  account: Account;
  onLogout: () => void;
  onPasswordChanged: () => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
  /** Snapshots used to derive the live connection status of each integration. */
  system: SystemSnapshot | null;
  tunnel: TunnelStatus | null;
  backups: BackupSummary | null;
  network: NetworkSnapshot | null;
  /** Editable branding / locale knobs persisted in app_settings. */
  instance: InstanceInfo | null;
  onInstanceSaved: (next: InstanceInfo) => void;
  appVersion?: string;
}

function fmtInterval(ms: number): string {
  if (ms === 0) return 'aus';
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000} min`;
  return `${ms / 3_600_000} h`;
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

interface IntegrationItem {
  name: string;
  endpoint: string;
  reachable: boolean | null;
  detail: string;
}

function deriveIntegrations(
  system: SystemSnapshot | null,
  tunnel: TunnelStatus | null,
  backups: BackupSummary | null,
  network: NetworkSnapshot | null,
): IntegrationItem[] {
  return [
    {
      name: 'Proxmox VE',
      endpoint: 'Pull · cluster/status',
      reachable: system ? system.host.online : null,
      detail: system ? `${system.host.node} · PVE ${system.host.pve_version ?? '?'}` : '—',
    },
    {
      name: 'Proxmox Backup Server',
      endpoint: 'Pull · admin/datastore',
      reachable: backups ? backups.reachable : null,
      detail: backups?.datastore ? backups.datastore.name : backups?.error ?? '—',
    },
    {
      name: 'Cloudflare API',
      endpoint: 'Pull · zone + tunnel',
      reachable: tunnel ? tunnel.reachable : null,
      detail: tunnel?.name ?? tunnel?.error ?? '—',
    },
    {
      name: 'UniFi Network',
      endpoint: 'Pull · integration v1',
      reachable: network ? network.reachable : null,
      detail: network?.auth_mode === 'api-key'
        ? 'Integration API'
        : network?.auth_mode === 'cookie'
          ? 'Cookie auth'
          : network?.error ?? '—',
    },
  ];
}

export function SettingsPage({
  settings,
  update,
  account,
  onLogout,
  onPasswordChanged,
  onError,
  onInfo,
  system,
  tunnel,
  backups,
  network,
  instance,
  onInstanceSaved,
  appVersion,
}: Props) {
  const isAdmin = account.role === 'admin';
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

  const integrations = useMemo(
    () => deriveIntegrations(system, tunnel, backups, network),
    [system, tunnel, backups, network],
  );

  const clearLocalCache = () => {
    if (!window.confirm('Lokalen Cache + Verlauf leeren? Theme + Polling-Einstellungen bleiben erhalten.')) return;
    try {
      // Wipe everything except the persisted UI settings.
      const keep = localStorage.getItem('rxf-ui');
      localStorage.clear();
      if (keep) localStorage.setItem('rxf-ui', keep);
      window.location.reload();
    } catch (e) {
      onError(`Cache-Clear fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="settings-section">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2>Einstellungen</h2>
        <span className="dimmer mono" style={{ fontSize: 11 }}>Auto-Speichern aktiv</span>
      </div>

      {/* Row 1: Allgemein + Konto */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-6">
          <SectionHead title="Allgemein" />
          <InstanceForm
            instance={instance}
            isAdmin={isAdmin}
            onSaved={onInstanceSaved}
            onError={onError}
          />
        </div>

        <div className="card col-6">
          <SectionHead title="Konto" />
          <Row title="Benutzername"><span className="mono">{account.username}</span></Row>
          <Row title="E-Mail"><span className="mono">{account.email || '—'}</span></Row>
          <Row title="Rolle">
            <span className={`role-pill ${account.role}`}>{account.role}</span>
          </Row>
        </div>

        <div className="card col-6">
          <SectionHead title="Darstellung" />
          <Row title="Theme">
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
          <Row title="Informationsdichte">
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
          <Row title="Sparklines">
            <Switch checked={settings.showSparklines} onChange={(v) => update('showSparklines', v)} ariaLabel="Sparklines anzeigen" />
          </Row>
          <Row title="Animationen reduzieren">
            <Switch checked={settings.reduceMotion} onChange={(v) => update('reduceMotion', v)} ariaLabel="Animationen reduzieren" />
          </Row>
        </div>
      </div>

      {/* Row 2: Aktualisierung + Benachrichtigungen */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-6">
          <SectionHead title="Aktualisierung &amp; Proben" />
          <Row title="Live-Status-Intervall" desc="Services, Host, Container, Tunnel.">
            <select
              className="input" style={{ width: 120 }}
              value={settings.refreshIntervalMs}
              onChange={(e) => update('refreshIntervalMs', Number(e.target.value))}
              aria-label="Live-Status-Intervall"
            >
              {intervalsLabel.fast.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </Row>
          <Row title="Backup-Polling" desc="PBS-Daten ändern sich selten.">
            <select
              className="input" style={{ width: 120 }}
              value={settings.pollBackupMs}
              onChange={(e) => update('pollBackupMs', Number(e.target.value))}
              aria-label="Backup-Polling"
            >
              {intervalsLabel.backup.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </Row>
          <Row title="Cert-Polling" desc="Ablaufdaten ändern sich nur täglich.">
            <select
              className="input" style={{ width: 120 }}
              value={settings.pollCertsMs}
              onChange={(e) => update('pollCertsMs', Number(e.target.value))}
              aria-label="Cert-Polling"
            >
              {intervalsLabel.certs.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </Row>
        </div>

        <div className="card col-6">
          <SectionHead title="Benachrichtigungen" />
          <Row title="Status-Änderungen" desc="Toast wenn ein Service von OK → degraded → down wechselt.">
            <Switch checked={settings.notifyStatusChange} onChange={(v) => update('notifyStatusChange', v)} ariaLabel="Status-Wechsel" />
          </Row>
          <Row title="Backup-Fehler" desc="Toast bei fehlgeschlagenen PBS-Jobs.">
            <Switch checked={settings.notifyBackupFail} onChange={(v) => update('notifyBackupFail', v)} ariaLabel="Backup-Fehler" />
          </Row>
          <Row title="Cert-Warnungen" desc="Schwelle in Tagen.">
            <select
              className="input" style={{ width: 100 }}
              value={settings.certWarnDays}
              onChange={(e) => update('certWarnDays', Number(e.target.value) as UISettings['certWarnDays'])}
              aria-label="Cert-Warn-Schwelle"
            >
              {CERT_WARN_DAYS.map((d) => (<option key={d} value={d}>{d === 0 ? 'Aus' : `${d} Tage`}</option>))}
            </select>
          </Row>
          <Row
            title="OS-Benachrichtigungen"
            desc={
              notifPerm === 'unsupported' ? 'Browser unterstützt keine Notifications.'
                : notifPerm === 'granted' ? 'Erlaubt.'
                : notifPerm === 'denied' ? 'Verweigert — im Browser freigeben.'
                : 'Native OS-Benachrichtigungen für kritische Alerts.'
            }
          >
            <button
              type="button" className="btn"
              disabled={notifPerm === 'unsupported' || notifPerm === 'granted' || notifPerm === 'denied'}
              onClick={requestBrowserNotifs}
            >
              {ICONS.bell}
              {notifPerm === 'granted' ? 'Erlaubt' : notifPerm === 'denied' ? 'Verweigert' : 'Berechtigung anfordern'}
            </button>
          </Row>
          <NtfyRows isAdmin={isAdmin} onError={onError} onInfo={onInfo} />
        </div>
      </div>

      {/* E-Mail reports — sits alone in a col-12 because the form is wide */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12">
          <SectionHead title="E-Mail-Reports (SMTP)" />
          <EmailReportsRows isAdmin={isAdmin} onError={onError} onInfo={onInfo} />
        </div>
      </div>

      {/* Row 3: Integrationen + Sicherheit */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-6">
          <SectionHead title="Integrationen" />
          <div className="settings-integ-list">
            {integrations.map((it) => {
              const tone = it.reachable === true ? 'ok' : it.reachable === false ? 'err' : 'warn';
              const label = it.reachable === true ? 'VERBUNDEN' : it.reachable === false ? 'OFFLINE' : 'PROBE';
              return (
                <div key={it.name} className="settings-integ-row">
                  <div className="settings-integ-meta">
                    <span className="settings-integ-name">{it.name}</span>
                    <span className="dim mono" style={{ fontSize: 11 }}>{it.detail}</span>
                  </div>
                  <span className={`badge ${tone}`}><Dot status={tone} /> {label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card col-6">
          <SectionHead title="Sicherheit &amp; Audit" />
          <Row title="Session-Cookie" desc="httpOnly · Secure · SameSite=Lax">
            <span className="mono dim" style={{ fontSize: 11 }}>rxf_session</span>
          </Row>
          <Row title="Hash-Algorithmus">
            <span className="mono">Argon2id</span>
          </Row>
          <Row title="Login-Rate-Limit" desc="5 Fehlversuche / 5 min · pro IP.">
            <span className="mono dim" style={{ fontSize: 11 }}>aktiv</span>
          </Row>
          <AutoAuditRow isAdmin={isAdmin} onError={onError} />
          <TwoFactorRow onError={onError} onInfo={onInfo} />
        </div>
      </div>

      {/* Row 4: Passwort ändern */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12">
          <SectionHead title="Passwort ändern" desc={`Mindestens ${MIN_PASSWORD_LEN} Zeichen.`} />
          <PasswordChangeForm onChanged={onPasswordChanged} onError={onError} />
        </div>
      </div>

      {/* Row 5: About */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12">
          <SectionHead title="About" />
          <div className="kv-stack">
            <div className="kv-row"><span className="kv-k">Version</span><span className="kv-v mono">{appVersion ?? 'dev'}</span></div>
            <div className="kv-row"><span className="kv-k">Backend</span><span className="kv-v mono">FastAPI · Python 3.11+</span></div>
            <div className="kv-row"><span className="kv-k">Frontend</span><span className="kv-v mono">React 19 · Vite 8 · TypeScript 6</span></div>
            <div className="kv-row">
              <span className="kv-k">OpenAPI</span>
              <a className="kv-v mono" style={{ color: 'var(--accent)' }} href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>
            </div>
            <div className="kv-row">
              <span className="kv-k">Repository</span>
              <a className="kv-v mono" style={{ color: 'var(--accent)' }} href="https://github.com/rxf-sys/admin.rxf-sys.de" target="_blank" rel="noreferrer">
                github.com/rxf-sys/admin.rxf-sys.de
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--err)' }}>Gefahrenzone</h3>
      </div>
      <div className="grid-12">
        <div className="card col-12 settings-danger">
          <div className="settings-danger-row">
            <div>
              <h4>Cache &amp; Verlauf leeren</h4>
              <p className="dim">Alle lokal gespeicherten Probe-Historien entfernen. Theme + Polling bleiben.</p>
            </div>
            <button type="button" className="btn" onClick={clearLocalCache}>Leeren</button>
          </div>
          <div className="settings-danger-row">
            <div>
              <h4>Abmelden</h4>
              <p className="dim">Beendet die aktuelle Session und revoked das Cookie serverseitig.</p>
            </div>
            <button type="button" className="btn danger" onClick={onLogout}>Logout</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** SMTP server config + weekly report scheduler in one block. Compact form
 * because most fields are small; the Test-Send button skips waiting for
 * Monday. */
function EmailReportsRows({
  isAdmin,
  onError,
  onInfo,
}: {
  isAdmin: boolean;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}) {
  const [smtp, setSmtp] = useState<SmtpConfig | null>(null);
  const [report, setReport] = useState<ReportConfig | null>(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.getSmtp(), api.getReportConfig()]);
      setSmtp(s);
      setReport(r);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  if (!smtp || !report) return <div className="dim" style={{ fontSize: 12 }}>Lade…</div>;

  const update = <K extends keyof SmtpConfig>(k: K, v: SmtpConfig[K]) => setSmtp({ ...smtp, [k]: v });
  const updateReport = <K extends keyof ReportConfig>(k: K, v: ReportConfig[K]) => setReport({ ...report, [k]: v });

  const save = async () => {
    if (!isAdmin || busy) return;
    setBusy(true);
    try {
      await api.updateSmtp({
        host: smtp.host, port: smtp.port, user: smtp.user,
        password: pw, starttls: smtp.starttls, from_addr: smtp.from_addr,
      });
      await api.updateReportConfig({
        enabled: report.enabled, hour: report.hour, to: report.to,
      });
      setPw('');
      await load();
      onInfo('SMTP- und Report-Einstellungen gespeichert');
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async () => {
    if (sending) return;
    setSending(true);
    try {
      const r = await api.sendReportNow();
      onInfo(`Test-Report gesendet an ${r.to}`);
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Row title="SMTP-Server" desc="Host:Port — z.B. smtp.fastmail.com:587">
        <input
          className="input mono" style={{ width: 220 }}
          value={smtp.host}
          onChange={(e) => update('host', e.target.value)}
          disabled={!isAdmin}
          placeholder="smtp.example.com"
        />
        <input
          className="input mono" style={{ width: 70, marginLeft: 6 }}
          type="number"
          value={smtp.port}
          onChange={(e) => update('port', Number(e.target.value))}
          disabled={!isAdmin}
        />
      </Row>
      <Row title="SMTP-User">
        <input
          className="input mono" style={{ width: 260 }}
          value={smtp.user}
          onChange={(e) => update('user', e.target.value)}
          disabled={!isAdmin}
          placeholder="user@example.com"
        />
      </Row>
      <Row
        title="SMTP-Passwort"
        desc={smtp.password_set ? 'Passwort gesetzt · neues eintragen zum Überschreiben.' : 'App-Password empfohlen.'}
      >
        <input
          className="input mono" style={{ width: 260 }}
          type="password" autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          disabled={!isAdmin}
          placeholder={smtp.password_set ? '••••••••' : ''}
        />
      </Row>
      <Row title="STARTTLS">
        <Switch checked={smtp.starttls} onChange={(v) => isAdmin && update('starttls', v)} ariaLabel="STARTTLS" />
      </Row>
      <Row title="From-Adresse" desc="Optional · fallback ist SMTP-User.">
        <input
          className="input mono" style={{ width: 260 }}
          value={smtp.from_addr}
          onChange={(e) => update('from_addr', e.target.value)}
          disabled={!isAdmin}
        />
      </Row>
      <Row title="Empfänger (Report)" desc="Ein oder mehrere E-Mail-Adressen (Komma-getrennt).">
        <input
          className="input mono" style={{ width: 260 }}
          value={report.to}
          onChange={(e) => updateReport('to', e.target.value)}
          disabled={!isAdmin}
          placeholder="admin@example.com"
        />
      </Row>
      <Row
        title="Wochenreport"
        desc={report.last_sent_week ? `Zuletzt versendet: KW ${report.last_sent_week}` : 'Montags automatisch versenden.'}
      >
        <Switch
          checked={report.enabled}
          onChange={(v) => isAdmin && updateReport('enabled', v)}
          ariaLabel="Wochenreport aktivieren"
        />
      </Row>
      {report.enabled && (
        <Row title="Trigger-Uhrzeit" desc="Montag · UTC.">
          <select
            className="input" style={{ width: 100 }}
            value={report.hour}
            onChange={(e) => updateReport('hour', Number(e.target.value))}
            disabled={!isAdmin}
            aria-label="Wochenreport-Stunde"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>
            ))}
          </select>
        </Row>
      )}
      {isAdmin && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn sm"
            type="button"
            onClick={sendNow}
            disabled={!smtp.host || !report.to || sending}
            title={!smtp.host || !report.to ? 'Zuerst SMTP + Empfänger speichern' : 'Test-Report jetzt senden'}
          >
            {sending ? 'Sende…' : 'Test-Report'}
          </button>
          <button className="btn primary sm" type="button" onClick={save} disabled={busy}>
            {busy ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      )}
    </>
  );
}

/** Two-factor authentication (TOTP) — enroll / disable / show remaining
 * backup codes. Backup codes from a fresh enrollment are kept in component
 * state until the user explicitly dismisses the dialog (they can't be
 * fetched again later). */
function TwoFactorRow({
  onError,
  onInfo,
}: {
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}) {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [disablePw, setDisablePw] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await api.get2faStatus());
    } catch { /* row stays blank */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const startSetup = async () => {
    try {
      setSetup(await api.begin2faSetup());
      setVerifyCode('');
    } catch (e) { onError(apiErrorMessage(e)); }
  };

  const verifySetup = async (e: FormEvent) => {
    e.preventDefault();
    if (verifying) return;
    setVerifying(true);
    try {
      const r = await api.verify2faSetup(verifyCode.trim());
      setBackupCodes(r.backup_codes);
      setSetup(null);
      onInfo('2FA aktiviert');
      await load();
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setVerifying(false);
    }
  };

  const submitDisable = async (e: FormEvent) => {
    e.preventDefault();
    if (!disablePw || disabling) return;
    setDisabling(true);
    try {
      await api.disable2fa(disablePw);
      setDisablePw('');
      setStatus({ enabled: false, pending: false, backup_codes_remaining: 0 });
      onInfo('2FA deaktiviert');
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setDisabling(false);
    }
  };

  if (!status) return <Row title="2FA"><span className="dim">Lade…</span></Row>;

  return (
    <>
      <Row
        title="2FA"
        desc={
          status.enabled
            ? `Aktiv · ${status.backup_codes_remaining} Backup-Codes übrig.`
            : 'Zweiter Faktor per TOTP (Aegis, 1Password, Google Authenticator).'
        }
      >
        {status.enabled ? (
          <span className="role-pill admin">AKTIV</span>
        ) : (
          <button type="button" className="btn sm" onClick={startSetup}>
            {ICONS.shield} Aktivieren
          </button>
        )}
      </Row>

      {setup && (
        <form
          onSubmit={verifySetup}
          style={{ marginTop: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-2)' }}
        >
          <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
            Scanne den QR-Code mit deiner Authenticator-App und gib dann den 6-stelligen Code ein.
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div
              style={{ width: 140, height: 140, background: '#fff', padding: 6, borderRadius: 8 }}
              dangerouslySetInnerHTML={{ __html: setup.qr_svg }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Geheimnis (manuell):</div>
              <code className="mono" style={{ fontSize: 11, wordBreak: 'break-all', userSelect: 'all' }}>
                {setup.secret_b32}
              </code>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <label className="login-field" style={{ flex: 1 }}>
                  <span>6-stelliger Code</span>
                  <input
                    className="input mono" type="text" inputMode="numeric"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    autoFocus
                    placeholder="123456"
                  />
                </label>
                <button className="btn primary sm" type="submit" disabled={verifying} style={{ height: 36 }}>
                  {verifying ? 'Prüfe…' : 'Bestätigen'}
                </button>
                <button className="btn sm" type="button" onClick={() => setSetup(null)} style={{ height: 36 }}>
                  Abbrechen
                </button>
              </div>
            </div>
          </div>
        </form>
      )}

      {backupCodes && (
        <div
          style={{ marginTop: 8, padding: 12, border: '1px solid var(--warn)', borderRadius: 'var(--r-2)', background: 'var(--warn-soft)' }}
        >
          <div className="dim" style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 8 }}>
            Notiere diese 8 Backup-Codes — jeder funktioniert genau einmal und sie werden NICHT erneut angezeigt.
          </div>
          <code
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 6,
              fontSize: 13,
              padding: 10,
              background: 'var(--surface-1)',
              borderRadius: 4,
              userSelect: 'all',
            }}
          >
            {backupCodes.map((c) => <span key={c}>{c}</span>)}
          </code>
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn primary sm" type="button" onClick={() => setBackupCodes(null)}>
              Notiert
            </button>
          </div>
        </div>
      )}

      {status.enabled && !setup && (
        <form onSubmit={submitDisable} style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label className="login-field" style={{ flex: 1 }}>
            <span>2FA deaktivieren · Passwort bestätigen</span>
            <input
              className="input" type="password" autoComplete="current-password"
              value={disablePw}
              onChange={(e) => setDisablePw(e.target.value)}
              placeholder="Passwort"
            />
          </label>
          <button className="btn danger sm" type="submit" disabled={!disablePw || disabling} style={{ height: 36 }}>
            {disabling ? 'Deaktiviere…' : 'Deaktivieren'}
          </button>
        </form>
      )}
    </>
  );
}

/** ntfy push config rows — server URL, topic, optional bearer token + test. */
function NtfyRows({
  isAdmin,
  onError,
  onInfo,
}: {
  isAdmin: boolean;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}) {
  const [cfg, setCfg] = useState<NtfyConfig | null>(null);
  const [base, setBase] = useState('');
  const [topic, setTopic] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.getNtfy()
      .then((c) => { setCfg(c); setBase(c.base); setTopic(c.topic); })
      .catch(() => { /* row stays blank */ });
  }, []);

  if (!cfg) {
    return <Row title="Push (ntfy)"><span className="dim">Lade…</span></Row>;
  }

  const dirty = base !== cfg.base || topic !== cfg.topic || token !== '';

  const save = async () => {
    if (!isAdmin || !dirty || busy) return;
    setBusy(true);
    try {
      await api.updateNtfy({ base, topic, token });
      const next = await api.getNtfy();
      setCfg(next);
      setToken('');
      onInfo('ntfy-Einstellungen gespeichert');
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await api.testNtfy();
      onInfo('Test-Push gesendet');
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Row title="ntfy-Server" desc="z.B. https://ntfy.rxf-sys.de — leer = ntfy aus.">
        <input
          className="input mono" style={{ width: 240 }}
          value={base}
          onChange={(e) => setBase(e.target.value)}
          disabled={!isAdmin}
          aria-label="ntfy-Basis-URL"
          placeholder="https://ntfy.example.com"
        />
      </Row>
      <Row title="ntfy-Topic">
        <input
          className="input mono" style={{ width: 240 }}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={!isAdmin}
          aria-label="ntfy-Topic"
          placeholder="rxf-admin"
        />
      </Row>
      <Row
        title="ntfy-Token"
        desc={cfg.token_set ? 'Token gesetzt · neuen eintragen zum Überschreiben.' : 'Optional · für geschützte Topics.'}
      >
        <input
          className="input mono" style={{ width: 240 }}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          autoComplete="new-password"
          disabled={!isAdmin}
          aria-label="ntfy-Token"
          placeholder={cfg.token_set ? '••••••••' : ''}
        />
      </Row>
      {isAdmin && (
        <div style={{ marginTop: 6, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn sm"
            type="button"
            onClick={sendTest}
            disabled={!cfg.base || !cfg.topic || testing}
            title={!cfg.base || !cfg.topic ? 'Zuerst speichern' : 'Test-Push schicken'}
          >
            {testing ? 'Sende…' : 'Test-Push'}
          </button>
          <button
            className="btn primary sm"
            type="button"
            onClick={save}
            disabled={!dirty || busy}
          >
            {busy ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      )}
    </>
  );
}

/** Auto-Audit row — toggle + hour picker. Loads its own state on mount. */
function AutoAuditRow({ isAdmin, onError }: { isAdmin: boolean; onError: (msg: string) => void }) {
  const [state, setState] = useState<{ enabled: boolean; hour: number; last?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getAutoAudit()
      .then((s) => setState({ enabled: s.enabled, hour: s.hour, last: s.last_run_date ?? null }))
      .catch(() => { /* row stays blank */ });
  }, []);

  const save = async (next: { enabled: boolean; hour: number }) => {
    if (!isAdmin || busy) return;
    setBusy(true);
    try {
      await api.updateAutoAudit(next);
      setState((cur) => cur ? { ...cur, ...next } : { ...next, last: null });
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <Row title="Auto-Audit"><span className="dim">Lade…</span></Row>;
  return (
    <>
      <Row
        title="Auto-Audit"
        desc={state.last ? `Letzter Auto-Lauf: ${state.last}` : 'Täglich automatisch ausführen.'}
      >
        <Switch
          checked={state.enabled}
          onChange={(v) => isAdmin && save({ enabled: v, hour: state.hour })}
          ariaLabel="Auto-Audit aktivieren"
        />
      </Row>
      {state.enabled && (
        <Row title="Trigger-Uhrzeit" desc="UTC. Loop prüft alle 5 min.">
          <select
            className="input" style={{ width: 100 }}
            value={state.hour}
            onChange={(e) => save({ enabled: true, hour: Number(e.target.value) })}
            disabled={!isAdmin}
            aria-label="Auto-Audit-Stunde"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>
            ))}
          </select>
        </Row>
      )}
    </>
  );
}

/** Editable instance branding form. Non-admins see the values read-only. */
function InstanceForm({
  instance,
  isAdmin,
  onSaved,
  onError,
}: {
  instance: InstanceInfo | null;
  isAdmin: boolean;
  onSaved: (next: InstanceInfo) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(instance?.instance_name ?? '');
  const [tz, setTz] = useState(instance?.default_timezone ?? '');
  const [fmt, setFmt] = useState<'12h' | '24h'>(instance?.time_format ?? '24h');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (instance) {
      setName(instance.instance_name);
      setTz(instance.default_timezone);
      setFmt(instance.time_format);
    }
  }, [instance]);

  if (!instance) {
    return <div className="dim" style={{ fontSize: 12 }}>Lade…</div>;
  }

  const dirty = name !== instance.instance_name
    || tz !== instance.default_timezone
    || fmt !== instance.time_format;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !dirty || busy) return;
    setBusy(true);
    try {
      const next = await api.updateInstance({
        instance_name: name,
        default_timezone: tz,
        time_format: fmt,
      });
      onSaved(next);
    } catch (err) {
      onError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <Row title="Instanz-Name" desc="Erscheint im Header und im Browser-Tab.">
        <input
          className="input" style={{ width: 200 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isAdmin}
          aria-label="Instanz-Name"
        />
      </Row>
      <Row title="Zeitzone" desc="IANA-Format, z.B. Europe/Berlin.">
        <input
          className="input mono" style={{ width: 200 }}
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          disabled={!isAdmin}
          aria-label="Zeitzone"
        />
      </Row>
      <Row title="Zeitformat">
        <select
          className="input" style={{ width: 100 }}
          value={fmt}
          onChange={(e) => setFmt(e.target.value as '12h' | '24h')}
          disabled={!isAdmin}
          aria-label="Zeitformat"
        >
          <option value="24h">24h</option>
          <option value="12h">12h</option>
        </select>
      </Row>
      {isAdmin && (
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn primary sm"
            type="submit"
            disabled={!dirty || busy}
          >
            {busy ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      )}
    </form>
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
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'row', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label className="login-field" style={{ flex: '1 1 180px' }}>
        <span>Aktuelles Passwort</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="login-field" style={{ flex: '1 1 180px' }}>
        <span>Neues Passwort</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label className="login-field" style={{ flex: '1 1 180px' }}>
        <span>Bestätigen</span>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <button className="btn primary" type="submit" disabled={busy} style={{ height: 36 }}>
        {busy ? 'Speichern…' : 'Ändern'}
      </button>
    </form>
  );
}
