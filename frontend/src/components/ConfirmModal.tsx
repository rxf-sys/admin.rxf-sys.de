import type { Guest } from '../types';

interface Props {
  open: boolean;
  guest: Guest | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ open, guest, onConfirm, onCancel }: Props) {
  if (!open || !guest) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Container neu starten?</h3>
        <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>{guest.name}</strong> ({guest.type} {guest.id}) wird neu gestartet.
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-3)' }}>
            Dadurch sind die zugehörigen Services für ca. 30–60 Sekunden nicht erreichbar.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel} type="button">
            Abbrechen
          </button>
          <button className="btn danger" onClick={onConfirm} type="button">
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}
