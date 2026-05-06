import type { CSSProperties, ReactNode } from 'react';
import type { Status } from '../types';

export const ICONS: Record<string, ReactNode> = {
  server: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><circle cx="6.5" cy="7" r="0.8" fill="currentColor" /><circle cx="6.5" cy="17" r="0.8" fill="currentColor" /></svg>,
  cpu: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="9" y="9" width="6" height="6" rx="0.5" /><path d="M9 3v2M12 3v2M15 3v2M9 19v2M12 19v2M15 19v2M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2" /></svg>,
  cloud: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6.5 18a4.5 4.5 0 0 1-.7-8.95 6 6 0 0 1 11.7 2.45 4 4 0 0 1-.5 7.95H6.5z" /></svg>,
  archive: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>,
  refresh: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 4v4h-4" /></svg>,
  sun: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></svg>,
  moon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  external: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></svg>,
  restart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" /></svg>,
  logs: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 10h12M4 14h16M4 18h10" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
  photo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5" /><circle cx="8.5" cy="10" r="1.5" /><path d="M3 17l5-4 4 3 3-2 6 4" /></svg>,
  doc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>,
  media: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M10 9l5 3-5 3V9z" fill="currentColor" /></svg>,
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9z" /></svg>,
  monitor: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12l5 5 9-11" /></svg>,
  warn: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4l10 17H2L12 4z" /><path d="M12 10v5M12 18v.5" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>,
};

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  showMinMax?: boolean;
}

export function Sparkline({
  data,
  color = 'var(--accent)',
  width = 120,
  height = 28,
  showMinMax = true,
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
  const minIdx = data.indexOf(min);
  const maxIdx = data.indexOf(max);
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <path d={path} fill="none" stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      {showMinMax && points[minIdx] && points[maxIdx] && (
        <>
          <circle cx={points[minIdx][0]} cy={points[minIdx][1]} r="1.8" fill="var(--text-3)" />
          <circle cx={points[maxIdx][0]} cy={points[maxIdx][1]} r="1.8" fill={color} />
        </>
      )}
    </svg>
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

export function Donut({ value, label, sublabel, color, size = 64, stroke = 6 }: DonutProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const trackColor = 'var(--surface-4)';
  const ringColor = color || (value > 85 ? 'var(--err)' : value > 70 ? 'var(--warn)' : 'var(--ok)');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={ringColor}
            strokeWidth={stroke}
            strokeDasharray={c}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 600ms ease' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-1)',
          }}
        >
          {Math.round(value)}
          <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 1 }}>%</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase' }}>
        {label}
      </div>
      {sublabel && <div className="mono" style={{ fontSize: 10, color: 'var(--text-4)' }}>{sublabel}</div>}
    </div>
  );
}

export function Dot({ status }: { status: Status }) {
  return <span className={`dot ${status}`} />;
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
