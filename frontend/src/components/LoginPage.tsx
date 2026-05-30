import { useState, type FormEvent } from 'react';
import { apiErrorMessage } from '../api/client';

interface Props {
  /** Performs the login. Returns true when the call was successful AND no
   * 2FA challenge is pending; returns false when 2FA is required (the page
   * then switches to the code-input step and re-calls onLogin with totp).
   * Throws on credential errors. */
  onLogin: (username: string, password: string, totp_code?: string) => Promise<boolean>;
}

export function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const done = await onLogin(
        username.trim(),
        password,
        needsTotp ? totp.trim() : undefined,
      );
      if (!done) {
        // Server signalled totp_required — switch the form to the code step.
        setNeedsTotp(true);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resetTo1stStep = () => {
    setNeedsTotp(false);
    setTotp('');
    setError(null);
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

        {needsTotp ? (
          <>
            <h1 className="login-heading">2FA-Code</h1>
            <p className="login-desc">
              Code aus deiner Authenticator-App eingeben — oder einen 8-stelligen Backup-Code.
            </p>
            <label className="login-field">
              <span>Code</span>
              <input
                className="input mono"
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                autoFocus
                required
                placeholder="123456"
              />
            </label>
          </>
        ) : (
          <>
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
          </>
        )}

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? (needsTotp ? 'Prüfe…' : 'Anmelden…') : (needsTotp ? 'Bestätigen' : 'Anmelden')}
        </button>
        {needsTotp && (
          <button
            type="button"
            className="btn login-secondary"
            onClick={resetTo1stStep}
            style={{ marginTop: 8 }}
          >
            Zurück
          </button>
        )}
      </form>
      <p className="login-foot">rxf-sys homeserver · admin dashboard</p>
    </div>
  );
}
