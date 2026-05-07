import { ICONS, fmtClock } from './primitives';

interface HeaderProps {
  servicesUp: number;
  servicesTotal: number;
  lastRefresh: number;
  onRefresh: () => void;
  refreshing: boolean;
  theme: 'dark' | 'light';
  onTheme: () => void;
  email: string | null;
  accent: 'peach' | 'indigo' | 'cyan' | 'green';
  onAccent: (a: 'peach' | 'indigo' | 'cyan' | 'green') => void;
}

export function Header(p: HeaderProps) {
  const allUp = p.servicesUp === p.servicesTotal && p.servicesTotal > 0;
  const initials = (p.email ?? '?').slice(0, 2).toUpperCase();
  return (
    <header className="dash-header">
      <div className="hdr-left">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <defs>
                <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--indigo)" />
                  <stop offset="100%" stopColor="var(--peach)" />
                </linearGradient>
              </defs>
              <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#lg1)" />
              <path
                d="M7 8h6a3 3 0 0 1 0 6H10l4 4M7 8v10"
                stroke="#fff"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div className="logo-text">
            <span className="logo-title">rxf-sys</span>
            <span className="logo-sub">admin</span>
          </div>
        </div>
        <span className="hdr-sep" />
        <span className="hdr-crumb mono">admin.rxf-sys.de</span>
      </div>

      <div className="hdr-mid">
        <div
          className={`global-status ${allUp ? 'ok' : 'warn'}`}
          role="status"
          aria-live="polite"
        >
          <span className={`dot ${allUp ? 'ok' : 'warn'}`} aria-hidden="true" />
          <span className="gs-label">
            {p.servicesTotal === 0
              ? 'Initialisierung…'
              : allUp
                ? 'Alle Systeme operational'
                : `${p.servicesTotal - p.servicesUp} von ${p.servicesTotal} Services degraded`}
          </span>
        </div>
      </div>

      <div className="hdr-right">
        <div className="hdr-meta">
          <span className="dimmer" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {p.refreshing && (
              <span className="poll-pulse" aria-label="Daten werden aktualisiert" />
            )}
            Last refresh
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {fmtClock(p.lastRefresh)}
          </span>
        </div>
        <button
          className={`btn icon ${p.refreshing ? 'spin' : ''}`}
          onClick={p.onRefresh}
          title="Aktualisieren"
          aria-label={p.refreshing ? 'Daten werden aktualisiert' : 'Daten aktualisieren'}
          type="button"
        >
          {ICONS.refresh}
        </button>
        <div className="accent-swatches" title="Accent">
          {(['peach', 'indigo', 'cyan', 'green'] as const).map((a) => (
            <button
              key={a}
              className={`swatch ${p.accent === a ? 'active' : ''}`}
              data-a={a}
              onClick={() => p.onAccent(a)}
              aria-label={a}
              type="button"
            />
          ))}
        </div>
        <button
          className="btn icon"
          onClick={p.onTheme}
          title="Theme wechseln"
          aria-label={p.theme === 'dark' ? 'Zu hellem Theme wechseln' : 'Zu dunklem Theme wechseln'}
          type="button"
        >
          {p.theme === 'dark' ? ICONS.sun : ICONS.moon}
        </button>
        <div className="hdr-user">
          <div className="avatar">{initials}</div>
          <div className="hdr-user-meta">
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{p.email ?? 'unknown'}</span>
            <span className="dimmer mono" style={{ fontSize: 10 }}>
              via Cloudflare Access
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
