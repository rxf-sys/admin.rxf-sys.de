import { ICONS } from './primitives';

interface HeaderProps {
  servicesUp: number;
  servicesTotal: number;
  servicesCritical: number;
  onRefresh: () => void;
  refreshing: boolean;
  email: string | null;
  onOpenPalette: () => void;
  paused: boolean;
  onTogglePause: () => void;
  onSnapshot: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  isDarkTheme: boolean;
  /** Branding name shown in the logo; falls back to 'rxf-sys'. */
  instanceName?: string;
}

export function Header(p: HeaderProps) {
  const degraded = p.servicesTotal - p.servicesUp;
  const status: 'ok' | 'warn' | 'err' = p.servicesCritical > 0 ? 'err' : degraded > 0 ? 'warn' : 'ok';
  const label = p.servicesTotal === 0
    ? 'Initialisierung…'
    : p.servicesCritical > 0
      ? `${p.servicesCritical} kritisches Issue${p.servicesCritical === 1 ? '' : 's'} · ${degraded} degraded`
      : degraded > 0
        ? `${degraded} von ${p.servicesTotal} Services degraded`
        : 'Alle Systeme operational';
  const initials = (p.email ?? 'RF').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'RF';
  return (
    <header className="dash-header">
      <div className="hdr-left">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <defs>
                <linearGradient id="lg-header" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--indigo)" />
                  <stop offset="100%" stopColor="var(--peach)" />
                </linearGradient>
              </defs>
              <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#lg-header)" />
              <path d="M7 8h6a3 3 0 0 1 0 6H10l4 4M7 8v10" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" />
            </svg>
          </span>
          <div className="logo-text">
            <span className="logo-title">{p.instanceName || 'rxf-sys'}</span>
            <span className="logo-sub">admin</span>
          </div>
        </div>
        <span className="hdr-sep" aria-hidden="true" />
        <span className="hdr-crumb mono">admin.rxf-sys.de</span>
      </div>

      <div className="hdr-mid">
        <div className={`global-status ${status}`} role="status" aria-live="polite">
          <span className={`dot ${status}`} aria-hidden="true" />
          <span className="gs-label">{label}</span>
          {p.servicesTotal > 0 && (
            <span className="gs-count">· {p.servicesUp}/{p.servicesTotal} healthy</span>
          )}
        </div>
      </div>

      <div className="hdr-right">
        <button
          className="cmdk-trigger"
          onClick={p.onOpenPalette}
          aria-label="Befehlspalette öffnen"
          type="button"
        >
          {ICONS.search}
          <span>Suchen, springen, ausführen…</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="hdr-group">
          <button
            className={`btn ${p.refreshing ? 'spin' : ''}`}
            onClick={p.onRefresh}
            title="Aktualisieren"
            aria-label="Jetzt aktualisieren"
            type="button"
          >
            {ICONS.refresh}
          </button>
          <span className="sep" aria-hidden="true" />
          <button
            className={`btn ${p.paused ? 'active' : ''}`}
            onClick={p.onTogglePause}
            title={p.paused ? 'Auto-Refresh fortsetzen' : 'Auto-Refresh pausieren'}
            aria-label={p.paused ? 'Auto-Refresh fortsetzen' : 'Auto-Refresh pausieren'}
            aria-pressed={p.paused}
            type="button"
          >
            {p.paused ? ICONS.play : ICONS.pause}
          </button>
          <span className="sep" aria-hidden="true" />
          <button
            className="btn"
            onClick={p.onSnapshot}
            title="Snapshot kopieren"
            aria-label="Snapshot kopieren"
            type="button"
          >
            {ICONS.download}
          </button>
        </div>
        <button
          className="btn icon"
          onClick={p.onToggleTheme}
          title={p.isDarkTheme ? 'Hell-Modus' : 'Dunkel-Modus'}
          aria-label="Theme wechseln"
          type="button"
        >
          {p.isDarkTheme ? ICONS.sun : ICONS.moon}
        </button>
        <button
          className="btn icon"
          onClick={p.onOpenSettings}
          title="Einstellungen"
          aria-label="Einstellungen"
          type="button"
        >
          {ICONS.settings}
        </button>
        <div className="avatar" title={p.email ?? 'unbekannt'}>{initials}</div>
      </div>
    </header>
  );
}
