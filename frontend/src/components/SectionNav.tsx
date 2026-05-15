import type { Section } from '../hooks/useSection';
import { ICONS } from './primitives';

interface SectionMeta {
  id: Section;
  label: string;
  icon: keyof typeof ICONS;
  /**
   * Number of items in this section that need attention. The tab renders a
   * little pill when this is > 0. Pass 0 to hide the pill.
   */
  alerts: number;
}

interface Props {
  active: Section;
  onChange: (s: Section) => void;
  alerts: Record<Section, number>;
}

const TABS: { id: Section; label: string; icon: keyof typeof ICONS }[] = [
  { id: 'overview', label: 'Übersicht', icon: 'grid' },
  { id: 'server', label: 'Server', icon: 'server' },
  { id: 'network', label: 'Netzwerk', icon: 'network' },
  { id: 'backup', label: 'Backup', icon: 'archive' },
  { id: 'cloudflare', label: 'Cloudflare', icon: 'cloud' },
];

export function SectionNav({ active, onChange, alerts }: Props) {
  return (
    <nav className="section-nav" aria-label="Dashboard-Bereich">
      <ul className="section-nav-list" role="tablist">
        {TABS.map((t) => {
          const isActive = t.id === active;
          const meta: SectionMeta = { ...t, alerts: alerts[t.id] ?? 0 };
          return (
            <li key={t.id} role="presentation">
              <button
                role="tab"
                type="button"
                aria-selected={isActive}
                aria-controls={`section-${t.id}`}
                className={`section-tab ${isActive ? 'active' : ''}`}
                onClick={() => onChange(t.id)}
              >
                <span className="section-tab-icon" aria-hidden="true">
                  {ICONS[t.icon] ?? '·'}
                </span>
                <span className="section-tab-label">{t.label}</span>
                {meta.alerts > 0 && (
                  <span
                    className="section-tab-alerts"
                    aria-label={`${meta.alerts} Warnung${meta.alerts === 1 ? '' : 'en'}`}
                    title={`${meta.alerts} Auffälligkeit${meta.alerts === 1 ? '' : 'en'}`}
                  >
                    {meta.alerts}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
