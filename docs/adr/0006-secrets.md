# ADR 0006 – Secrets: Speicherung, Schlüssel, Rotation

- **Status:** Akzeptiert (18.10.2026)
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §7 (Secrets), §8; `docs/analysis/legacy-core.md` §3 (Klartext-Secrets im Altcode)

## Kontext

Plugins brauchen API-Tokens, Passwörter, Client-Secrets und Schlüssel. Im
Altsystem liegen sie im Klartext in `.env` und in `app_settings`
(`smtp_password`, `ntfy_token`), TOTP-Secrets im Klartext in `user_totp`.
Auftrag: verschlüsselt gespeichert, nur schreibbar, nie in Responses, Logs
oder Fehlermeldungen; Schlüssel aus Datei oder ENV; Rotation möglich.

## Optionen

| Option | Bewertung |
|---|---|
| **AES-256-GCM mit `node:crypto`, Master-Schlüssel aus Datei** | keine Abhängigkeit, Standardverfahren, AEAD |
| libsodium (`secretbox`/XChaCha20-Poly1305) | größere Nonces, aber zusätzliche native Abhängigkeit |
| externer Secret-Store (Vault, OpenBao) | zusätzlicher Dienst, für ein Heim-Setup unverhältnismäßig |

## Entscheidung

**AES-256-GCM über `node:crypto`**, ein Master-Schlüssel je Installation.

- **Schlüsselquelle:** Datei, Pfad aus `RXF_MASTER_KEY_FILE` (Standard
  `/run/secrets/rxf_master_key`, als Docker-Secret eingebunden). `RXF_MASTER_KEY`
  als ENV ist nur für Entwicklung erlaubt; in Produktion bricht der Start
  dann mit Fehler ab. Format: 32 Byte, Base64. Ohne Schlüssel startet der
  Server nicht.
- **Erstinstallation:** `rxf keygen` erzeugt den Schlüssel; das Setup-Skript
  legt ihn mit Rechten `0400` für den Container-Benutzer an.
- **Verfahren je Wert:** zufälliger 96-Bit-IV, 128-Bit-Tag, Associated Data
  = `instance_id | slot | field | key_id`. Damit lässt sich ein Chiffrat nicht
  in eine andere Instanz oder ein anderes Feld kopieren.
- **Schlüssel-ID** (`key_id`) an jedem Wert. **Rotation:** `rxf rotate-key
  --new <datei>` entschlüsselt alle Werte mit dem alten und verschlüsselt sie
  in einer Transaktion mit dem neuen Schlüssel; danach wird der alte
  Schlüssel nicht mehr gelesen. Rotation einzelner Plugin-Secrets
  (neues Token) geht über das UI und verlangt Re-Auth (ADR 0005).
- **Was verschlüsselt wird:** alle `secret: true`-Felder der Plugins,
  Kanal-Zugangsdaten (SMTP, ntfy, Webhook-Signaturschlüssel), TOTP-Secrets.
  Passwort-Hashes, Sitzungs- und Backup-Code-Hashes bleiben Hashes.
- **Nur schreibbar:** Die API liefert für Secret-Felder nur
  `{ set: true, updatedAt }`. Leerer Wert beim Speichern = unverändert
  (Muster aus dem Altcode, `test_routers_misc.py`). Entschlüsselte Werte
  existieren nur im Server-Speicher des Collectors.
- **Nie im Log:** pino-Redaction für bekannte Pfade (`*.password`,
  `*.token`, `*.secret`, `authorization`, `cookie`, `x-api-key`) und ein
  Redaction-Muster für Token-Formate (`cfut_…`, `tskey-…`,
  `PVEAPIToken=…`). Fehlerobjekte aus dem HTTP-Client werden vor dem Loggen
  von Headern und Query-Strings befreit. Ein Test schreibt bekannte Secrets
  durch alle Fehlerpfade und prüft, dass sie im Log nicht vorkommen.

## Folgen

- **Backup:** Eine Datenbanksicherung ohne Master-Schlüssel ist für Secrets
  wertlos. `docs/OPERATIONS.md` beschreibt die getrennte Sicherung des
  Schlüssels (z. B. in einem Passwortmanager) und den Restore-Test.
- Geht der Schlüssel verloren, müssen alle Plugin-Secrets und TOTP neu
  eingerichtet werden; Konten und Daten bleiben erhalten.
- Der v1-Import (ADR 0004) verschlüsselt alle übernommenen Secrets sofort;
  die alte `.env` muss danach gelöscht oder sicher verwahrt werden.
