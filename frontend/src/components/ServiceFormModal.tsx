import { useEffect, useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../api/client';
import type { ServiceInput } from '../types';
import { ICONS } from './primitives';

/** Icons offered for a custom service — a curated subset of the icon set. */
const ICON_CHOICES = [
  'cloud', 'server', 'monitor', 'lock', 'archive', 'media', 'photo',
  'doc', 'home', 'network', 'globe', 'shield', 'disk', 'router', 'wifi',
] as const;

export interface ServiceFormModalProps {
  mode: 'create' | 'edit';
  /** Required in edit mode — the id of the service being patched. */
  editId?: string;
  /** Pre-filled field values (used by quick-add from a guest and by edit). */
  initial?: Partial<ServiceInput>;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}

export function ServiceFormModal({ mode, editId, initial, onClose, onSaved, onError }: ServiceFormModalProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [internalUrl, setInternalUrl] = useState(initial?.internal_url ?? 'http://');
  const [extUrl, setExtUrl] = useState(initial?.ext_url ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? 'cloud');
  const [desc, setDesc] = useState(initial?.desc ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmedInternal = internalUrl.trim();
    if (!name.trim()) {
      onError('Name darf nicht leer sein');
      return;
    }
    if (!/^https?:\/\/.+/.test(trimmedInternal)) {
      onError('Interne URL muss mit http:// oder https:// beginnen und eine Adresse enthalten');
      return;
    }
    const body: ServiceInput = {
      name: name.trim(),
      internal_url: trimmedInternal,
      icon,
      desc: desc.trim(),
      ext_url: extUrl.trim() || null,
    };
    setBusy(true);
    try {
      if (mode === 'edit' && editId) {
        await api.updateService(editId, body);
      } else {
        await api.createService(body);
      }
      onSaved();
    } catch (err) {
      onError(apiErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-h">
          <h3>{mode === 'edit' ? 'Service bearbeiten' : 'Service hinzufügen'}</h3>
          <button className="btn icon" type="button" onClick={onClose} aria-label="Schließen">
            {ICONS.x}
          </button>
        </div>
        <div className="modal-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="login-field">
            <span>Name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="login-field">
            <span>Interne URL</span>
            <input
              className="input"
              value={internalUrl}
              onChange={(e) => setInternalUrl(e.target.value)}
              placeholder="http://192.168.2.x:port"
              required
            />
          </label>
          <label className="login-field">
            <span>Externe URL (optional)</span>
            <input
              className="input"
              value={extUrl}
              onChange={(e) => setExtUrl(e.target.value)}
              placeholder="https://service.example.com"
            />
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label className="login-field" style={{ flex: '0 0 130px' }}>
              <span>Icon</span>
              <select className="input" value={icon} onChange={(e) => setIcon(e.target.value)}>
                {ICON_CHOICES.map((ic) => (
                  <option key={ic} value={ic}>{ic}</option>
                ))}
              </select>
            </label>
            <label className="login-field" style={{ flex: '1 1 200px' }}>
              <span>Beschreibung (optional)</span>
              <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 12 }}>
            <span className="svc-icon" aria-hidden="true">{ICONS[icon] ?? ICONS.cloud}</span>
            <span>Vorschau-Icon</span>
          </div>
          <button
            className="btn primary"
            type="submit"
            disabled={busy}
            style={{ marginTop: 6, width: '100%', justifyContent: 'center', height: 38 }}
          >
            {busy ? 'Speichern…' : mode === 'edit' ? 'Änderungen speichern' : 'Service anlegen'}
          </button>
        </div>
      </form>
    </div>
  );
}
