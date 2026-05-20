import type { CSSProperties, ReactNode } from 'react';
import type { Status } from '../types';

export const ICONS: Record<string, ReactNode> = {
  server: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><circle cx="6.5" cy="7" r="0.8" fill="currentColor" /><circle cx="6.5" cy="17" r="0.8" fill="currentColor" /></svg>,
  cpu: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="9" y="9" width="6" height="6" /><path d="M9 3v2M12 3v2M15 3v2M9 19v2M12 19v2M15 19v2M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2" /></svg>,
  ram: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="8" width="18" height="9" rx="1" /><path d="M7 13v-2M11 13v-2M15 13v-2M19 13v-2" /></svg>,
  disk: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><ellipse cx="12" cy="6" rx="8" ry="2.5" /><path d="M4 6v12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6" /><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></svg>,
  cloud: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6.5 18a4.5 4.5 0 0 1-.7-8.95 6 6 0 0 1 11.7 2.45 4 4 0 0 1-.5 7.95H6.5z" /></svg>,
  archive: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>,
  lock: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
  photo: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5" /><circle cx="8.5" cy="10" r="1.5" /><path d="M3 17l5-4 4 3 3-2 6 4" /></svg>,
  doc: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>,
  media: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M10 9l5 3-5 3V9z" fill="currentColor" /></svg>,
  home: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9z" /></svg>,
  monitor: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></svg>,
  network: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M12 7.5v4M12 11.5L5.8 17M12 11.5L18.2 17" /></svg>,
  grid: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  refresh: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 4v4h-4" /></svg>,
  sun: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></svg>,
  moon: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" /></svg>,
  search: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" strokeLinecap="round" /></svg>,
  pause: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="6" y="5" width="4" height="14" rx="0.8" /><rect x="14" y="5" width="4" height="14" rx="0.8" /></svg>,
  play: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><path d="M7 5v14l12-7L7 5z" /></svg>,
  restart: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" /></svg>,
  logs: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 10h12M4 14h16M4 18h10" /></svg>,
  ext: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></svg>,
  external: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></svg>,
  check: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12l5 5 9-11" /></svg>,
  close: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  x: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M6 18L18 6" /></svg>,
  warn: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4l10 17H2L12 4z" /><path d="M12 10v5M12 18v.5" /></svg>,
  chevron: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg>,
  bell: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 9a6 6 0 1 1 12 0v5l2 3H4l2-3V9zM10 20a2 2 0 1 0 4 0" /></svg>,
  info: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.5" strokeLinecap="round" /></svg>,
  temp: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 5a2 2 0 1 1 4 0v9.3a4 4 0 1 1-4 0V5z" /><circle cx="12" cy="17" r="1.5" fill="currentColor" /></svg>,
  download: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>,
  zap: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>,
  filter: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5h16l-6 8v6l-4-2v-4L4 5z" /></svg>,
  settings: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="9" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>,
  gear: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="9" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>,
  density: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  copy: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></svg>,
  trash: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>,
  plus: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  edit: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>,
  arrow_up: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  arrow_down: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  wifi: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 12.5a10 10 0 0 1 14 0M8 16a5 5 0 0 1 8 0" /><circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none" /></svg>,
  router: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="13" width="18" height="6" rx="1.5" /><circle cx="7" cy="16" r="0.8" fill="currentColor" /><circle cx="10" cy="16" r="0.8" fill="currentColor" /><path d="M12 13V9M8 9V7M16 9V7M12 9V5" strokeLinecap="round" /></svg>,
  shield: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" /></svg>,
  globe: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>,
  user: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
  key: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></svg>,
  palette: <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.5 1.5-1.3 0-.4-.2-.7-.4-1-.3-.4-.5-.7-.5-1.2 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8z" /><circle cx="7.5" cy="11.5" r="1" fill="currentColor" /><circle cx="11.5" cy="7.5" r="1" fill="currentColor" /><circle cx="16.5" cy="11.5" r="1" fill="currentColor" /></svg>,
};

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  area?: boolean;
  stroke?: number;
  showMinMax?: boolean;
}

export function Sparkline({
  data,
  color = 'var(--accent)',
  width = 120,
  height = 28,
  area = false,
  stroke = 1.4,
  showMinMax = false,
}: SparklineProps) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / Math.max(1, data.length - 1);
  const points = data.map((v, i): [number, number] => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return [x, y];
  });
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${path} L${width.toFixed(1)},${height} L0,${height} Z`;
  const lastPt = points[points.length - 1];
  const minIdx = data.indexOf(min);
  const maxIdx = data.indexOf(max);
  return (
    <svg
      width={width}
      height={height}
      style={{ display: 'block', overflow: 'visible' }}
      role="img"
      aria-label={`Verlauf: min ${Math.round(min)}, max ${Math.round(max)}`}
    >
      {area && <path d={areaPath} fill={color} opacity="0.12" />}
      <path d={path} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
      {lastPt && <circle cx={lastPt[0]} cy={lastPt[1]} r={Math.max(1.6, stroke + 0.6)} fill={color} />}
      {showMinMax && points[minIdx] && points[maxIdx] && (
        <>
          <circle cx={points[minIdx][0]} cy={points[minIdx][1]} r="1.8" fill="var(--text-3)" />
          <circle cx={points[maxIdx][0]} cy={points[maxIdx][1]} r="1.8" fill={color} />
        </>
      )}
    </svg>
  );
}

interface AreaChartProps {
  series: number[];
  secondary?: number[];
  color?: string;
  secondaryColor?: string;
  height?: number;
  max?: number;
  gridLines?: number;
}

export function AreaChart({
  series,
  secondary,
  color = 'var(--accent)',
  secondaryColor = 'var(--info)',
  height = 130,
  max,
  gridLines = 3,
}: AreaChartProps) {
  if (!series || series.length === 0) return null;
  const all = secondary ? [...series, ...secondary] : series;
  const m = max || Math.max(...all) * 1.15 || 1;
  const w = 800;
  const path = (data: number[]) => {
    const stepX = w / Math.max(1, data.length - 1);
    const pts = data.map((v, i): [number, number] => [i * stepX, height - (v / m) * (height - 8) - 4]);
    const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaP = `${line} L${w},${height} L0,${height} Z`;
    return { line, area: areaP };
  };
  const a = path(series);
  const b = secondary ? path(secondary) : null;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} aria-hidden="true">
      {Array.from({ length: gridLines }).map((_, i) => {
        const y = (height / (gridLines + 1)) * (i + 1);
        return <line key={i} x1="0" x2={w} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 5" />;
      })}
      {b && (
        <>
          <path d={b.area} fill={secondaryColor} opacity="0.12" />
          <path d={b.line} fill="none" stroke={secondaryColor} strokeWidth="1.5" />
        </>
      )}
      <path d={a.area} fill={color} opacity="0.16" />
      <path d={a.line} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

interface RingProps {
  value: number;
  label?: string;
  sub?: string;
  color?: string;
  size?: number;
  stroke?: number;
}

export function Ring({ value, label, sub, color, size = 80, stroke = 7 }: RingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(100, Math.max(0, value));
  const offset = c - (v / 100) * c;
  const ringColor = color || (v > 90 ? 'var(--err)' : v > 75 ? 'var(--warn)' : 'var(--ok)');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-4)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor} strokeWidth={stroke}
            strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 600ms ease' }} />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-mono)', fontWeight: 700,
        }}>
          <span style={{ fontSize: 15, color: 'var(--text-1)', letterSpacing: '-0.5px' }}>{Math.round(v)}</span>
          <span style={{ fontSize: 8.5, color: 'var(--text-4)', letterSpacing: 0.5, marginTop: -2 }}>%</span>
        </div>
      </div>
      {(label || sub) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {label && <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-3)' }}>{label}</span>}
          {sub && <span className="mono" style={{ fontSize: 11, color: 'var(--text-4)' }}>{sub}</span>}
        </div>
      )}
    </div>
  );
}

interface DonutProps {
  value: number;
  label: string;
  sublabel?: string;
  color?: string;
  size?: number;
  stroke?: number;
}

// Centered variant retained for legacy callers (OverviewCards etc).
export function Donut({ value, label, sublabel, color, size = 64, stroke = 6 }: DonutProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const ringColor = color || (value > 85 ? 'var(--err)' : value > 70 ? 'var(--warn)' : 'var(--ok)');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
      role="img" aria-label={`${label}: ${Math.round(value)} Prozent${sublabel ? `, ${sublabel}` : ''}`}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-4)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor} strokeWidth={stroke}
            strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 600ms ease' }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
          {Math.round(value)}
          <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 1 }}>%</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase' }}>{label}</div>
      {sublabel && <div className="mono" style={{ fontSize: 10, color: 'var(--text-4)' }}>{sublabel}</div>}
    </div>
  );
}

interface TrendBarsProps {
  data: number[];
  color?: string;
  max?: number;
  height?: number;
  threshold?: number;
}

export function TrendBars({ data, color = 'var(--accent)', max, height = 36, threshold }: TrendBarsProps) {
  if (!data || data.length === 0) return null;
  const m = max || Math.max(...data) || 1;
  return (
    <div className="host-metric-trend">
      {data.map((v, i) => {
        const h = Math.max(2, (v / m) * height);
        const isHi = threshold != null ? v > threshold : i === data.length - 1;
        return (
          <span key={i} className={`tick ${isHi ? 'hi' : ''}`} style={{ height: `${h}px`, background: isHi ? color : undefined }} />
        );
      })}
    </div>
  );
}

export interface StackedSegment {
  name: string;
  gb: number;
  color: string;
}

export function StackedBar({ segments }: { segments: StackedSegment[] }) {
  return (
    <div className="stacked-bar">
      {segments.map((s, i) => (
        <span key={`${s.name}-${i}`} className="seg" style={{ flex: s.gb, background: s.color }} title={`${s.name}: ${s.gb.toFixed(1)} GB`} />
      ))}
    </div>
  );
}

export function Reach({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`reach ${ok ? 'ok' : 'off'}`}>{label}</span>;
}

const STATUS_LABEL: Record<Status, string> = {
  ok: 'Status OK',
  warn: 'Status Warnung',
  err: 'Status Fehler',
  idle: 'Status inaktiv',
};

export function Dot({ status }: { status: Status }) {
  return <span className={`dot ${status}`} role="status" aria-label={STATUS_LABEL[status]} />;
}

interface NumProps {
  value: string | number;
  unit?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}
export function Num({ value, unit, size = 'md' }: NumProps) {
  const sizes = { sm: 13, md: 18, lg: 24, xl: 32 };
  const style: CSSProperties = { fontSize: sizes[size], fontWeight: 600, color: 'var(--text-1)' };
  return (
    <span className="mono" style={style}>
      {value}
      {unit && <span style={{ fontSize: '0.6em', marginLeft: 3, opacity: 0.55, fontWeight: 500 }}>{unit}</span>}
    </span>
  );
}

export function fmtUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtBytes(b: number): string {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return iso ?? '—';
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'gerade';
  if (diff < 3600) return `vor ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `vor ${Math.round(diff / 3600)} h`;
  return `vor ${Math.round(diff / 86400)} Tagen`;
}

export function fmtClock(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, '0'))
    .join(':');
}
