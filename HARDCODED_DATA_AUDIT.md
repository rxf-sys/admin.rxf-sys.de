# Hardcoded-Data-Audit — admin.rxf-sys.de

Stand: 2026-06-09 · Branch `claude/affectionate-gauss-bVelI`
Frage: Stehen irgendwo statische Daten im Code, die eigentlich dynamisch aus
den APIs kommen sollten?

## Ergebnis

**Keine Demo-/Mock-/Fake-Datensätze** im Backend oder Frontend. Alle
Dashboard-Werte (System, Services, Backups, Netzwerk, Certs, Cloudflare,
Konten) werden zur Laufzeit aus den jeweiligen APIs geladen. Die einzigen
statischen Strings waren Branding-Fallbacks und **ein** echter hartcodierter
Domainname — der ist jetzt dynamisch.

## Gefunden + behoben

| Ort | War | Jetzt |
|---|---|---|
| `frontend/App.tsx` | `zoneName="rxf-sys.de"` fest an die Cloudflare-Sektion übergeben | `instance?.zone_name` — Backend liefert `cf_zone_name` über `GET /api/instance` |
| `frontend/Header.tsx` | Krümelpfad fest `admin.rxf-sys.de` | `window.location.host` (echter Deployment-Host) |

Backend-Änderung: `GET/PUT /api/instance` geben jetzt zusätzlich
`zone_name` (read-only, aus `settings.cf_zone_name`) zurück.

## Bewusst belassen (legitim)

### Branding-Fallbacks (kein API-Wert nötig)
- `LoginPage.tsx`: Titel „rxf-sys" + „rxf-sys homeserver · admin dashboard"
  — reines Login-Branding vor der Authentifizierung (kein Account-Kontext).
- `Header.tsx`: Logo-Fallback `'rxf-sys'`, **nur** wenn `instance_name` leer
  ist (der echte Name kommt aus `/api/instance`).
- `App.tsx`: Krümel-Fallback `'admin.rxf-sys.de'`, nur solange `/api/instance`
  noch nicht geladen ist.
- `SettingsPage.tsx`: GitHub-Repo-Link + ntfy-Beispiel-URL (Hilfetexte).
- `ServiceFormModal.tsx`: Placeholder `http://192.168.2.x:port` (Eingabehilfe).

### Config-Defaults (alle env-überschreibbar)
`backend/app/config.py` enthält Defaults wie `cf_zone_name`, `cf_account_id`,
`proxmox_host`, `unifi_host`, `probe_targets`. Das sind **Pydantic-Settings-
Defaults**, die per `.env` / Umgebungsvariablen überschrieben werden — der
normale 12-Factor-Weg. Die `probe_targets` werden zudem beim ersten Start nur
**geseedet** und sind danach über die Service-Registry (UI) editierbar.

### `GUEST_SERVICE_LABELS` — Hinweis (nicht geändert)
`backend/app/clients/proxmox.py:14` enthält ein fest verdrahtetes Mapping
VMID → Service-Name (z.B. `102: "Vaultwarden"`). Das sind **Default-Labels**,
die pro Gast über `PATCH /api/system/guests/{vmid}/service` (UI) überschrieben
werden — die Overrides liegen in der Registry-DB und gewinnen. Es ist also
„dynamisch mit Defaults", kein toter statischer Wert. Bewusst nicht entfernt,
weil die Defaults für den Erstkontakt nützlich sind und ein Entfernen die
bestehenden Labels nicht verbessern würde. Wer komplett leere Defaults will,
kann das Dict leeren — die UI-Overrides bleiben davon unberührt.

## Fazit

Die Anwendung ist durchgängig API-getrieben. Nach diesem Commit gibt es keinen
hartcodierten Domainnamen/Host mehr im ausgelieferten UI; verbleibende
statische Strings sind Branding-Fallbacks und env-überschreibbare
Config-Defaults.
