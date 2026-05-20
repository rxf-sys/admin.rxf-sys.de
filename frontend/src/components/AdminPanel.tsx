import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../api/client';
import type { Account, Role } from '../types';
import { ICONS, fmtTimeAgo } from './primitives';

interface Props {
  /** The currently logged-in admin — used to disable self-destructive actions. */
  currentUserId: number;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}

const MIN_PW = 8;

export function AdminPanel({ currentUserId, onError, onInfo }: Props) {
  const [users, setUsers] = useState<Account[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [pwTarget, setPwTarget] = useState<Account | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.adminListUsers();
      setUsers(r.users);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateUser = async (id: number, body: { role?: Role; disabled?: boolean }) => {
    try {
      await api.adminUpdateUser(id, body);
      await load();
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };

  const deleteUser = async (u: Account) => {
    if (!window.confirm(`Konto „${u.username}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) {
      return;
    }
    try {
      await api.adminDeleteUser(u.id);
      onInfo(`Konto „${u.username}" gelöscht`);
      await load();
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };

  return (
    <section className="admin-section">
      <div className="dash-section-head" style={{ marginBottom: 12 }}>
        <h2>Konten-Verwaltung <span className="count">· {users?.length ?? '…'}</span></h2>
        <div className="section-tools">
          <button className="btn sm" type="button" onClick={() => setCreating((v) => !v)}>
            {ICONS.user} {creating ? 'Abbrechen' : 'Neues Konto'}
          </button>
        </div>
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

      <div className="grid-12">
        <div className="card col-12" style={{ padding: 0 }}>
          {users === null ? (
            <div className="dim" style={{ fontSize: 12, padding: 18 }}>Lade Konten…</div>
          ) : (
            <table className="user-table">
              <thead>
                <tr>
                  <th>Benutzer</th>
                  <th>E-Mail</th>
                  <th>Rolle</th>
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
                      <td className="dim">{u.email || '—'}</td>
                      <td>
                        <select
                          className="hours-select"
                          value={u.role}
                          onChange={(e) => updateUser(u.id, { role: e.target.value as Role })}
                          aria-label={`Rolle von ${u.username}`}
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                        </select>
                      </td>
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
    </section>
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
  const [role, setRole] = useState<Role>('user');
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
            <option value="user">user</option>
            <option value="admin">admin</option>
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
