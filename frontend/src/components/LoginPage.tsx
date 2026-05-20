import { useState, type FormEvent } from 'react';
import { apiErrorMessage } from '../api/client';

interface Props {
  onLogin: (username: string, password: string) => Promise<void>;
}

export function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onLogin(username.trim(), password);
    } catch (err) {
      setError(apiErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="32" height="32">
              <defs>
                <linearGradient id="lg-login" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--indigo)" />
                  <stop offset="100%" stopColor="var(--peach)" />
                </linearGradient>
              </defs>
              <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#lg-login)" />
              <path d="M7 8h6a3 3 0 0 1 0 6H10l4 4M7 8v10" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" />
            </svg>
          </span>
          <div className="login-brand-text">
            <span className="login-title">rxf-sys</span>
            <span className="login-sub">admin</span>
          </div>
        </div>

        <h1 className="login-heading">Anmelden</h1>
        <p className="login-desc">Melde dich mit deinem Konto an, um fortzufahren.</p>

        <label className="login-field">
          <span>Benutzername</span>
          <input
            className="input"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </label>

        <label className="login-field">
          <span>Passwort</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? 'Anmelden…' : 'Anmelden'}
        </button>
      </form>
      <p className="login-foot">rxf-sys homeserver · admin dashboard</p>
    </div>
  );
}
