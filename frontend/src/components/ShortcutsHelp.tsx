import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ['⌘', 'K'], description: 'Befehlspalette öffnen (auch Ctrl+K)' },
  { keys: ['?'], description: 'Diese Hilfe öffnen' },
  { keys: ['Esc'], description: 'Modal/Drawer/Palette schließen' },
  { keys: ['↑', '↓'], description: 'In Palette navigieren' },
  { keys: ['↵'], description: 'In Palette auswählen' },
];

export function ShortcutsHelp({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="shortcuts-title" style={{ margin: 0, fontSize: 16 }}>
          Tastenkürzel
        </h3>
        <ul className="shortcuts-list">
          {SHORTCUTS.map((s, i) => (
            <li key={i} className="shortcuts-row">
              <span className="shortcuts-keys">
                {s.keys.map((k, ki) => (
                  <kbd key={ki}>{k}</kbd>
                ))}
              </span>
              <span className="shortcuts-desc">{s.description}</span>
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} type="button">
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
