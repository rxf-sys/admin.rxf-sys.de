import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiErrorMessage } from '../api/client';
import type { Account, AdminSession, ApiToken, CreatedApiToken, Role } from '../types';
import { ConfirmModal } from './ConfirmModal';
import { ICONS, fmtTimeAgo } from './primitives';

/** A pending destructive action awaiting confirmation via ConfirmModal. */
interface ConfirmAction {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  run: () => Promise<void>;
}

interface Props {
  /** The currently logged-in admin — used to disable self-destructive actions. */
  currentUserId: number;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}

const MIN_PW = 8;

export function AdminPanel({ currentUserId, onError, onInfo }: Props) {
  const [users, setUsers] = useState<Account[] | null>(null);
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [revealToken, setRevealToken] = useState<CreatedApiToken | null>(null);
  const [pwTarget, setPwTarget] = useState<Account | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, s, t] = await Promise.all([
        api.adminListUsers(),
        api.adminListSessions(),
        api.adminListTokens(),
      ]);
      setUsers(u.users);
      setSessions(s.sessions);
      setTokens(t.tokens);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  }, [onError]);

  const revokeToken = (t: ApiToken) => {
    setConfirmAction({
      title: 'Token revoken?',
      message: (
        <p style={{ margin: 0 }}>
          Token <strong>{t.name}</strong> ({t.username}) wird sofort ungültig. Anwendungen,
          die ihn nutzen, verlieren den Zugriff.
        </p>
      ),
      confirmLabel: 'Revoken',
      run: async () => {
        try {
          await api.adminDeleteToken(t.id);
          onInfo(`Token ${t.token_prefix}… revoked`);
          await load();
        } catch (e) {
          onError(apiErrorMessage(e));
        }
      },
    });
  };

  useEffect(() => {
    void load();
  }, [load]);

  const revokeSession = (s: AdminSession) => {
    const isSelf = s.user_id === currentUserId;
    setConfirmAction({
      title: isSelf ? 'Eigene Session beenden?' : 'Session revoken?',
      message: isSelf ? (
        <p style={{ margin: 0 }}>
          Session <span className="mono">{s.token_prefix}…</span> beenden? Du wirst sofort
          ausgeloggt.
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          Session von <strong>{s.username}</strong> (<span className="mono">{s.token_prefix}…</span>)
          revoken? Der Nutzer wird ausgeloggt.
        </p>
      ),
      confirmLabel: isSelf ? 'Ausloggen' : 'Revoken',
      run: async () => {
        try {
          await api.adminRevokeSession(s.token_prefix);
          onInfo(`Session ${s.token_prefix}… revoked`);
          await load();
        } catch (e) {
          onError(apiErrorMessage(e));
        }
      },
    });
  };

  const userCount = users?.length ?? 0;
  const adminCount = users?.filter((u) => u.role === 'admin' && !u.disabled).length ?? 0;
  const disabledCount = users?.filter((u) => u.disabled).length ?? 0;
  const sessionCount = sessions?.length ?? 0;
  const tokenCount = tokens?.length ?? 0;

  const updateUser = async (
    id: number,
    body: { role?: Role; disabled?: boolean; email?: string | null },
  ) => {
    try {
      await api.adminUpdateUser(id, body);
      await load();
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };

  const deleteUser = (u: Account) => {
    setConfirmAction({
      title: 'Konto löschen?',
      message: (
        <p style={{ margin: 0 }}>
          Konto <strong>{u.username}</strong> wird endgültig gelöscht. Das kann{' '}
          <strong>nicht rückgängig</strong> gemacht werden.
        </p>
      ),
      confirmLabel: 'Löschen',
      run: async () => {
        try {
          await api.adminDeleteUser(u.id);
          onInfo(`Konto „${u.username}" gelöscht`);
          await load();
        } catch (e) {
          onError(apiErrorMessage(e));
        }
      },
    });
  };

  return (
    <section className="admin-section">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2>Kontenverwaltung</h2>
        <div className="section-tools">
          <button className="btn sm primary" type="button" onClick={() => setCreating((v) => !v)}>
            {ICONS.user} {creating ? 'Abbrechen' : 'Benutzer anlegen'}
          </button>
        </div>
      </div>

      {/* KPI strip — 4 admin overview tiles */}
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <KpiTile label="Benutzer" value={userCount} sub={`${userCount - disabledCount} aktiv`} tone="info" />
        <KpiTile label="Administratoren" value={adminCount} sub="volle Rechte" tone="ok" />
        <KpiTile label="Aktive Sessions" value={sessionCount} sub="laufende Logins" tone="info" />
        <KpiTile label="API-Tokens" value={tokenCount} sub={tokenCount ? `${tokenCount} Bearer` : 'keine'} tone="info" />
      </div>

      {creating && (
        <div className="grid-12" style={{ marginBottom: 16 }}>
          <div className="card col-12">
            <CreateUserForm
              onCreated={async () => {
                setCreating(false);
                onInfo('Konto angelegt');
                await load();
              }}
              onError={onError}
            />
          </div>
        </div>
      )}

      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
          Benutzer <span className="h3-sub">· {userCount}</span>
        </h3>
      </div>

      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12 card-scroll-x" style={{ padding: 0 }}>
          {users === null ? (
            <div className="dim" style={{ fontSize: 12, padding: 18 }}>Lade Konten…</div>
          ) : (
            <table className="user-table">
              <thead>
                <tr>
                  <th>Benutzer</th>
                  <th>E-Mail</th>
                  <th>Realm</th>
                  <th>Rolle</th>
                  <th>Quelle</th>
                  <th>Status</th>
                  <th>Letzter Login</th>
                  <th style={{ textAlign: 'right' }}>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === currentUserId;
                  return (
                    <tr key={u.id} className={u.disabled ? 'is-disabled' : ''}>
                      <td style={{ fontWeight: 600 }}>
                        {u.username}
                        {isSelf && <span className="dim" style={{ fontWeight: 400 }}> · du</span>}
                      </td>
                      <td className="dim">
                        <EmailCell
                          user={u}
                          onSave={(email) => updateUser(u.id, { email })}
                        />
                      </td>
                      <td className="mono dim" style={{ fontSize: 11 }}>{u.realm}</td>
                      <td>
                        <select
                          className="hours-select"
                          value={u.role}
                          onChange={(e) => updateUser(u.id, { role: e.target.value as Role })}
                          aria-label={`Rolle von ${u.username}`}
                        >
                          <option value="admin">admin</option>
                          <option value="operator">operator</option>
                          <option value="viewer">viewer</option>
                          <option value="user">user (legacy)</option>
                        </select>
                      </td>
                      <td className="mono dim" style={{ fontSize: 11 }}>{u.source}</td>
                      <td>
                        <span className={`role-pill ${u.disabled ? 'user' : 'admin'}`}>
                          {u.disabled ? 'deaktiviert' : 'aktiv'}
                        </span>
                      </td>
                      <td className="mono dim" style={{ fontSize: 11 }}>
                        {u.last_login_at ? fmtTimeAgo(new Date(u.last_login_at * 1000).toISOString()) : 'nie'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="row-actions" style={{ opacity: 1 }}>
                          <button
                            className="btn sm"
                            type="button"
                            onClick={() => setPwTarget(u)}
                          >
                            Passwort
                          </button>
                          <button
                            className="btn sm"
                            type="button"
                            onClick={() => updateUser(u.id, { disabled: !u.disabled })}
                            disabled={isSelf}
                            title={isSelf ? 'Das eigene Konto kann nicht deaktiviert werden' : undefined}
                          >
                            {u.disabled ? 'Aktivieren' : 'Deaktivieren'}
                          </button>
                          <button
                            className="btn sm danger"
                            type="button"
                            onClick={() => deleteUser(u)}
                            disabled={isSelf}
                            title={isSelf ? 'Das eigene Konto kann nicht gelöscht werden' : undefined}
                          >
                            Löschen
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Rollen</h3>
      </div>
      <div className="grid-12" style={{ marginBottom: 16 }}>
        <div className="card col-12">
          <RolesTable users={users ?? []} />
        </div>
      </div>

      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
          Aktive Sessions <span className="h3-sub">· {sessionCount}</span>
        </h3>
      </div>

      <div className="grid-12">
        <div className="card col-12 card-scroll-x" style={{ padding: 0 }}>
          {sessions === null ? (
            <div className="dim" style={{ fontSize: 12, padding: 18 }}>Lade Sessions…</div>
          ) : sessions.length === 0 ? (
            <div className="dim" style={{ fontSize: 12, padding: 18 }}>Keine aktiven Sessions.</div>
          ) : (
            <table className="user-table">
              <thead>
                <tr>
                  <th>Benutzer</th>
                  <th>Token</th>
                  <th>Letzte Aktivität</th>
                  <th>Gültig bis</th>
                  <th style={{ textAlign: 'right' }}>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.token_prefix}>
                    <td style={{ fontWeight: 600 }}>
                      {s.username}
                      {s.user_id === currentUserId && <span className="dim" style={{ fontWeight: 400 }}> · du</span>}
                      <div className="dim mono" style={{ fontSize: 11, fontWeight: 400 }}>{s.email ?? '—'}</div>
                    </td>
                    <td className="mono dim" style={{ fontSize: 11 }}>{s.token_prefix}…</td>
                    <td className="mono dim" style={{ fontSize: 11 }}>
                      {fmtTimeAgo(new Date(s.last_seen_at * 1000).toISOString())}
                    </td>
                    <td className="mono dim" style={{ fontSize: 11 }}>
                      {fmtTimeAgo(new Date(s.expires_at * 1000).toISOString())}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn sm danger"
                        type="button"
                        onClick={() => revokeSession(s)}
                      >
                        Revoken
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
          API-Tokens <span className="h3-sub">· {tokenCount}</span>
        </h3>
        <div className="section-tools">
          <button className="btn sm primary" type="button" onClick={() => setCreatingToken(true)}>
            {ICONS.key} Token erstellen
          </button>
        </div>
      </div>

      <div className="grid-12">
        <div className="card col-12 card-scroll-x" style={{ padding: 0 }}>
          {tokens === null ? (
            <div className="dim" style={{ fontSize: 12, padding: 18 }}>Lade Tokens…</div>
          ) : tokens.length === 0 ? (
            <div className="dim" style={{ fontSize: 12, padding: 18 }}>
              Noch keine API-Tokens. Klicke &bdquo;Token erstellen&ldquo;, um den ersten Bearer-Token anzulegen.
            </div>
          ) : (
            <table className="user-table">
              <thead>
                <tr>
                  <th>Token-ID</th>
                  <th>Name</th>
                  <th>Besitzer</th>
                  <th>Scope</th>
                  <th>Erstellt</th>
                  <th>Läuft ab</th>
                  <th>Zuletzt genutzt</th>
                  <th style={{ textAlign: 'right' }}>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td className="mono dim" style={{ fontSize: 11 }}>{t.token_prefix}…</td>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td className="mono dim" style={{ fontSize: 11 }}>{t.username}</td>
                    <td>
                      <span className={`role-pill ${t.scope === 'admin' ? 'admin' : 'user'}`}>{t.scope}</span>
                    </td>
                    <td className="mono dim" style={{ fontSize: 11 }}>
                      {fmtTimeAgo(new Date(t.created_at * 1000).toISOString())}
                    </td>
                    <td className="mono dim" style={{ fontSize: 11 }}>
                      {t.expires_at ? fmtTimeAgo(new Date(t.expires_at * 1000).toISOString()) : 'nie'}
                    </td>
                    <td className="mono dim" style={{ fontSize: 11 }}>
                      {t.last_used_at ? fmtTimeAgo(new Date(t.last_used_at * 1000).toISOString()) : 'nie'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm danger" type="button" onClick={() => revokeToken(t)}>
                        Revoken
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {creatingToken && (
        <CreateTokenModal
          onClose={() => setCreatingToken(false)}
          onCreated={(created) => {
            setCreatingToken(false);
            setRevealToken(created);
            void load();
          }}
          onError={onError}
        />
      )}

      {revealToken && (
        <RevealTokenModal token={revealToken} onClose={() => setRevealToken(null)} />
      )}

      {pwTarget && (
        <PasswordModal
          user={pwTarget}
          onClose={() => setPwTarget(null)}
          onDone={() => {
            onInfo(`Passwort für „${pwTarget.username}" gesetzt`);
            setPwTarget(null);
          }}
          onError={onError}
        />
      )}

      <ConfirmModal
        open={!!confirmAction}
        title={confirmAction?.title ?? ''}
        message={confirmAction?.message ?? null}
        confirmLabel={confirmAction?.confirmLabel ?? 'Bestätigen'}
        danger
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          void action?.run();
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </section>
  );
}

/** Compact roles overview — one row per role with its description + member count. */
function RolesTable({ users }: { users: Account[] }) {
  const rolesInfo: { role: Role; label: string; desc: string }[] = [
    { role: 'admin',    label: 'Administrator', desc: 'Vollzugriff auf alle Ressourcen, Konten- und Audit-Verwaltung.' },
    { role: 'operator', label: 'Operator',      desc: 'Service-CRUD, Audit ausführen, Sessions verwalten. Keine Konten-Verwaltung.' },
    { role: 'viewer',   label: 'Viewer',        desc: 'Nur Lesen — alle Tabs sichtbar, keine schreibenden Aktionen.' },
    { role: 'user',     label: 'User (legacy)', desc: 'Alter Bestandswert vor Rollen-Refactor. Behandelt wie viewer.' },
  ];
  const counts = users.reduce<Record<string, number>>((acc, u) => {
    acc[u.role] = (acc[u.role] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="roles-list">
      {rolesInfo.map((r) => (
        <div key={r.role} className="role-row">
          <span className={`role-pill ${r.role === 'admin' ? 'admin' : 'user'}`}>
            {r.label}
          </span>
          <div className="role-desc dim">{r.desc}</div>
          <span className="mono dim role-count">{counts[r.role] ?? 0} Nutzer</span>
        </div>
      ))}
    </div>
  );
}

function CreateTokenModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (t: CreatedApiToken) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write' | 'admin'>('read');
  const [ttlDays, setTtlDays] = useState<number | ''>(90);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.createMyToken({
        name: name.trim(),
        scope,
        ttl_days: ttlDays === '' ? null : Number(ttlDays),
      });
      onCreated(created);
    } catch (err) {
      onError(apiErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-h">
          <h3>Neuer API-Token</h3>
          <button className="btn icon" type="button" onClick={onClose} aria-label="Schließen">{ICONS.x}</button>
        </div>
        <div className="modal-b">
          <label className="login-field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="z.B. monitoring-bot" />
          </label>
          <label className="login-field" style={{ marginTop: 12 }}>
            <span>Scope</span>
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'read' | 'write' | 'admin')}>
              <option value="read">read (nur GET)</option>
              <option value="write">write (POST/PATCH/DELETE)</option>
              <option value="admin">admin (volle Rechte)</option>
            </select>
          </label>
          <label className="login-field" style={{ marginTop: 12 }}>
            <span>Gültigkeitsdauer (Tage, leer = unbegrenzt)</span>
            <input
              className="input" type="number" min={1} max={3650}
              value={ttlDays}
              onChange={(e) => setTtlDays(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy} style={{ marginTop: 14, width: '100%', justifyContent: 'center', height: 38 }}>
            {busy ? 'Erstelle…' : 'Token erstellen'}
          </button>
        </div>
      </form>
    </div>
  );
}

function RevealTokenModal({ token, onClose }: { token: CreatedApiToken; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="modal-h">
          <h3>Token erstellt · {token.meta.name}</h3>
          <button className="btn icon" type="button" onClick={onClose} aria-label="Schließen">{ICONS.x}</button>
        </div>
        <div className="modal-b">
          <div className="dim" style={{ fontSize: 12, marginBottom: 10, color: 'var(--warn)' }}>
            Dieser Token wird nur jetzt angezeigt. Kopiere ihn jetzt — er kann später nicht erneut abgerufen werden.
          </div>
          <code
            className="mono"
            style={{
              display: 'block',
              padding: '12px 14px',
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-2)',
              fontSize: 12,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {token.token}
          </code>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn sm" type="button" onClick={copy}>
              {ICONS.copy} {copied ? 'Kopiert!' : 'Kopieren'}
            </button>
            <button className="btn primary sm" type="button" onClick={onClose}>Verstanden</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub: string;
  tone: 'ok' | 'warn' | 'err' | 'info';
}) {
  const color =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : 'var(--text-1)';
  return (
    <div className="card col-3 admin-kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value mono" style={{ color }}>
        {value}
      </span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

/** E-Mail cell with an inline editor so an admin can add it after the fact. */
function EmailCell({ user, onSave }: { user: Account; onSave: (email: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (next !== (user.email ?? '')) onSave(next);
    };
    return (
      <input
        className="input svc-cell-input"
        type="email"
        value={draft}
        autoFocus
        placeholder="name@example.com"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="svc-cell-edit"
      title="E-Mail-Adresse bearbeiten"
      onClick={() => {
        setDraft(user.email ?? '');
        setEditing(true);
      }}
    >
      <span>{user.email || '—'}</span>
      {ICONS.edit}
    </button>
  );
}

function CreateUserForm({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < MIN_PW) {
      onError(`Passwort muss mindestens ${MIN_PW} Zeichen haben`);
      return;
    }
    setBusy(true);
    try {
      await api.adminCreateUser({ username: username.trim(), password, role, email: email.trim() || null });
      onCreated();
    } catch (err) {
      onError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="card-h">
        <h3>Neues Konto anlegen</h3>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="login-field" style={{ flex: '1 1 160px' }}>
          <span>Benutzername</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="login-field" style={{ flex: '1 1 180px' }}>
          <span>E-Mail (optional)</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="login-field" style={{ flex: '1 1 160px' }}>
          <span>Passwort</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="login-field" style={{ flex: '0 0 120px' }}>
          <span>Rolle</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">admin</option>
            <option value="operator">operator</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <button className="btn primary" type="submit" disabled={busy} style={{ height: 38 }}>
          {busy ? 'Anlegen…' : 'Anlegen'}
        </button>
      </div>
    </form>
  );
}

function PasswordModal({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: Account;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < MIN_PW) {
      onError(`Passwort muss mindestens ${MIN_PW} Zeichen haben`);
      return;
    }
    setBusy(true);
    try {
      await api.adminResetPassword(user.id, password);
      onDone();
    } catch (err) {
      onError(apiErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-h">
          <h3>Passwort setzen · {user.username}</h3>
          <button className="btn icon" type="button" onClick={onClose} aria-label="Schließen">
            {ICONS.x}
          </button>
        </div>
        <div className="modal-b">
          <label className="login-field">
            <span>Neues Passwort</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy} style={{ marginTop: 14, width: '100%', justifyContent: 'center', height: 38 }}>
            {busy ? 'Speichern…' : 'Passwort setzen'}
          </button>
        </div>
      </form>
    </div>
  );
}
