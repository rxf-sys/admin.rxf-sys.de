import { REFRESH_INTERVALS_MS } from '../hooks/useTheme';
import { ICONS, fmtClock } from './primitives';
import { StatusHistory } from './StatusHistory';

interface HeaderProps {
  servicesUp: number;
  servicesTotal: number;
  lastRefresh: number;
  onRefresh: () => void;
  refreshing: boolean;
  theme: 'dark' | 'light' | 'auto';
  onCycleTheme: () => void;
  resolvedTheme: 'dark' | 'light';
  email: string | null;
  accent: 'peach' | 'indigo' | 'cyan' | 'green';
  onAccent: (a: 'peach' | 'indigo' | 'cyan' | 'green') => void;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
  paused: boolean;
  onTogglePause: () => void;
  density: 'compact' | 'cozy';
  onToggleDensity: () => void;
  onSnapshot: () => void;
  refreshIntervalMs: number;
  onChangeRefreshInterval: (ms: number) => void;
}

function refreshLabel(ms: number): string {
  if (ms === 0) return 'aus';
  if (ms < 60_000) return `${ms / 1000}s`;
  return `${ms / 60_000}min`;
}

function themeIcon(theme: 'dark' | 'light' | 'auto', resolved: 'dark' | 'light') {
  if (theme === 'auto') return ICONS.monitor;
  return resolved === 'dark' ? ICONS.sun : ICONS.moon;
}

function themeTooltip(theme: 'dark' | 'light' | 'auto'): string {
  if (theme === 'dark') return 'Theme: dunkel — klicken für hell';
  if (theme === 'light') return 'Theme: hell — klicken für Auto';
  return 'Theme: Auto (System-Präferenz) — klicken für dunkel';
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
        <StatusHistory
          pollTs={p.lastRefresh}
          servicesUp={p.servicesUp}
          servicesTotal={p.servicesTotal}
        />
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
          className="btn cmdk-trigger"
          onClick={p.onOpenPalette}
          title="Befehlspalette öffnen"
          aria-label="Befehlspalette öffnen"
          type="button"
        >
          {ICONS.search}
          <span className="cmdk-trigger-label">Suche</span>
          <kbd>⌘K</kbd>
        </button>
        <label className="refresh-select" title="Auto-Refresh-Intervall">
          <span className="dimmer" aria-hidden="true">⟳</span>
          <select
            value={p.refreshIntervalMs}
            onChange={(e) => p.onChangeRefreshInterval(Number(e.target.value))}
            aria-label="Auto-Refresh-Intervall"
          >
            {REFRESH_INTERVALS_MS.map((ms) => (
              <option key={ms} value={ms}>
                {refreshLabel(ms)}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`btn icon ${p.refreshing ? 'spin' : ''}`}
          onClick={p.onRefresh}
          title="Jetzt aktualisieren"
          aria-label={p.refreshing ? 'Daten werden aktualisiert' : 'Daten jetzt aktualisieren'}
          type="button"
        >
          {ICONS.refresh}
        </button>
        <button
          className={`btn icon ${p.paused ? 'active' : ''}`}
          onClick={p.onTogglePause}
          title={p.paused ? 'Auto-Refresh fortsetzen' : 'Auto-Refresh pausieren'}
          aria-label={p.paused ? 'Auto-Refresh fortsetzen' : 'Auto-Refresh pausieren'}
          aria-pressed={p.paused}
          type="button"
        >
          {p.paused ? ICONS.play : ICONS.pause}
        </button>
        <button
          className="btn icon"
          onClick={p.onSnapshot}
          title="Aktuellen Zustand als JSON in die Zwischenablage kopieren"
          aria-label="Snapshot kopieren"
          type="button"
        >
          {ICONS.download}
        </button>
        <button
          className={`btn icon ${p.density === 'cozy' ? 'active' : ''}`}
          onClick={p.onToggleDensity}
          title={p.density === 'compact' ? 'Cozy-Modus (mehr Abstand)' : 'Compact-Modus (dichter)'}
          aria-label="Dichte umschalten"
          aria-pressed={p.density === 'cozy'}
          type="button"
        >
          {ICONS.density}
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
          onClick={p.onCycleTheme}
          title={themeTooltip(p.theme)}
          aria-label={themeTooltip(p.theme)}
          type="button"
        >
          {themeIcon(p.theme, p.resolvedTheme)}
        </button>
        <button
          className="btn icon"
          onClick={p.onOpenHelp}
          title="Tastenkürzel (?)"
          aria-label="Tastenkürzel anzeigen"
          type="button"
        >
          <span className="mono" style={{ fontSize: 14, fontWeight: 700 }}>?</span>
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
