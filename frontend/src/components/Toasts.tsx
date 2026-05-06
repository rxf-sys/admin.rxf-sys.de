import { ICONS } from './primitives';

export interface Toast {
  id: number;
  level: 'ok' | 'warn' | 'err';
  title: string;
  body?: string;
}

interface Props {
  toasts: Toast[];
}

const ICON_FOR: Record<Toast['level'], React.ReactNode> = {
  ok: ICONS.check,
  warn: ICONS.warn,
  err: ICONS.x,
};

export function Toasts({ toasts }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-icon">{ICON_FOR[t.level]}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
            {t.body && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
