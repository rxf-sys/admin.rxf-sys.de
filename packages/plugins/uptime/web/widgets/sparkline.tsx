import type { Locale } from '@rxf/web-sdk';
import { translator } from '../i18n.ts';
import styles from '../uptime.module.css';

const WIDTH = 120;
const HEIGHT = 28;
const PAD = 2;

interface Point {
  ts: number;
  avg: number;
}

/**
 * Plain SVG sparkline (dataviz skill: one series, 2 px line, no axes). The trend is the point, so the
 * accessible name states the range instead of every value.
 */
export function Sparkline({ points, locale }: { points: readonly Point[]; locale: Locale }) {
  const t = translator(locale);
  if (points.length < 2) {
    return (
      <svg
        className={styles.spark}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={t('widget.sparklineEmpty')}
      >
        <line x1={PAD} x2={WIDTH - PAD} y1={HEIGHT / 2} y2={HEIGHT / 2} className={styles.sparkEmpty} />
      </svg>
    );
  }
  const values = points.map((p) => p.avg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = (points[0] as Point).ts;
  const span = Math.max((points.at(-1) as Point).ts - first, 1);
  const range = Math.max(max - min, 1);
  const path = points
    .map((p, i) => {
      const x = PAD + ((p.ts - first) / span) * (WIDTH - 2 * PAD);
      const y = HEIGHT - PAD - ((p.avg - min) / range) * (HEIGHT - 2 * PAD);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className={styles.spark}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={t('widget.sparkline', { min: Math.round(min), max: Math.round(max) })}
    >
      <path d={path} className={styles.sparkLine} />
    </svg>
  );
}
