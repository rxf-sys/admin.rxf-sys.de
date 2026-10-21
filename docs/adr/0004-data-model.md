# ADR 0004 – Datenmodell, Zeitreihen und Migrationen

- **Status:** Akzeptiert (18.10.2026)
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §6.3, ADR 0001 §6 (Probe-Historie migrieren), ADR 0003, `docs/analysis/legacy-core.md` §4

## Kontext

Widgets wie „Status gesamt“ oder „Was braucht Aufmerksamkeit“ funktionieren
nur plugin-übergreifend, wenn alle Plugins in ein gemeinsames Modell
schreiben. Zeitreihen müssen in SQLite passen (kein externer DB-Server) und
nach Auftrag abgestuft aufbewahrt werden: Rohdaten 48 h, 5-Minuten-Mittel
30 Tage, Stundenmittel 1 Jahr, einstellbar.

## Optionen

| Option | Bewertung |
|---|---|
| **Eine Entitätstabelle mit `kind` + JSON-Attributen, getrennte Tabellen für Metriken, Alarme, Audit** | ein Modell für alle Plugins, einfache Abfragen über alle Plugins; Plugin-Details in `attrs` (per Zod typisiert) |
| Eine Tabelle je Kern-Entität | strenger typisiert, aber zehn fast gleiche Tabellen und Joins für jede Übersicht |
| Zeitreihen in separater DB (InfluxDB, Prometheus) | mehr Betrieb, widerspricht „kein externer DB-Server“ |

## Entscheidung

**Eine SQLite-Datei** (`/data/rxf-admin-v2.db`, WAL, `foreign_keys = ON` auf
jeder Verbindung – Lehre #5) mit diesen Bereichen:

### Konten und Sitzungen (Details ADR 0005)

`users`, `user_passwords`, `user_totp`, `user_webauthn_credentials`,
`user_backup_codes`, `sessions`, `login_attempts`, `setup_state`.

### Instanz und Plugins

| Tabelle | Wichtige Spalten |
|---|---|
| `settings` | `key`, `value_json` (Instanzname, Zeitzone, Sprache, Aufbewahrung) |
| `plugin_instances` | `id` (UUID), `plugin_id`, `name`, `status` (`draft`/`active`/`paused`), `config_json` (ohne Secrets), `actions_json` (freigeschaltete Aktionen), `tls_pins_json`, `created_by`, `created_at`, `updated_at` |
| `secrets` | `instance_id`, `slot`, `field`, `ciphertext`, `iv`, `tag`, `key_id`, `updated_at` (ADR 0006) |
| `p_<plugin>_*` | plugin-eigene Tabellen, immer mit `instance_id` und `ON DELETE CASCADE` |

### Normalisierte Entitäten

| Tabelle | Spalten |
|---|---|
| `entities` | `id` (INTEGER), `instance_id`, `kind`, `external_id`, `name`, `status`, `status_reason`, `last_seen`, `parent_id`, `attrs_json`, `updated_at`; eindeutig `(instance_id, kind, external_id)` |
| `entity_links` | `from_id`, `to_id`, `relation` (`runs-on`, `backed-up-by`, `exposes`, `same-as`), `source` (`auto`/`user`) |

- `kind` ∈ `Host`, `Guest`, `NetworkDevice`, `Client`, `Service`
  (`attrs.endpoint` für Endpunkte), `Backup`, `Certificate`, `StoragePool`.
  `Alert` und `Metric` aus dem Auftrag sind eigene Tabellen (unten), weil sie
  andere Zugriffsmuster haben.
- `status` ∈ `ok`, `warn`, `crit`, `unknown`, `paused`. Jede Entität trägt
  über die Instanz `pluginId`, dazu `externalId` und `lastSeen` (Auftrag §6.3).
- `attrs_json` folgt einem Zod-Schema je `kind` (Kern-Felder) plus einem
  optionalen Plugin-Teil; der Kern validiert beim Schreiben.
- `entity_links` verbindet Plugins ohne harte Abhängigkeit: PBS-Gruppe ↔
  PVE-Gast, Cloudflare-Ingress ↔ Uptime-Check, Docker-Host ↔ PVE-Gast.
  `auto`-Links werden über stabile Merkmale (VMID, MAC, Hostname)
  vorgeschlagen, `user`-Links setzt der Admin.

### Zeitreihen

| Tabelle | Inhalt | Standard-Aufbewahrung |
|---|---|---|
| `metric_series` | `id`, `entity_id`, `name` (`cpu.util`, `uptime.response_ms` …), `unit` | – |
| `metric_raw` | `series_id`, `ts` (Unix-ms), `value` – `WITHOUT ROWID`, PK `(series_id, ts)` | 48 h |
| `metric_5m` | `series_id`, `bucket`, `avg`, `min`, `max`, `count` | 30 Tage |
| `metric_1h` | dto. | 365 Tage |

- Ein Hintergrundjob aggregiert alle 5 min abgeschlossene Buckets
  (idempotent über `INSERT … ON CONFLICT DO UPDATE`) und löscht danach
  abgelaufene Zeilen in kleinen Batches. Aufbewahrung je Stufe ist in
  `settings` einstellbar.
- Abfragen wählen die Stufe nach Zeitfenster (≤ 48 h roh, ≤ 30 Tage 5 min,
  sonst 1 h) und liefern höchstens ~1.000 Punkte je Serie.
- Schreiben gebündelt in einer Transaktion je Collector-Lauf.

**Größenabschätzung** für 300 Serien mit 30-s-Takt: roh 300 × 5.760 ≈ 1,7 Mio.
Zeilen (~40 MB), 5 min 300 × 8.640 ≈ 2,6 Mio. (~90 MB), 1 h 300 × 8.760 ≈
2,6 Mio. (~90 MB), zusammen ~220 MB. Die Annahme von ~25–35 Byte je Zeile
wird in Phase 8 mit einem Lasttest (500 Gäste) überprüft.

### Alarme

| Tabelle | Inhalt |
|---|---|
| `alert_rules` | Regel (Schwellwert, Ausfall, Ablauf), Ziel (Entitäts-Filter), Dauer, Schwere, Ruhezeiten, Wiederholung, Kanäle; Herkunft (`template:<plugin>/<id>` oder `user`) |
| `alert_state` | je Regel × Entität: `state` (`ok`/`pending`/`firing`), `since`, `last_notified_at`, `ack_by` – **persistiert**, damit ein Neustart weder doppelt noch gar nicht alarmiert (Befund in `legacy-core.md` §3) |
| `alert_events` | Historie: ausgelöst, bestätigt, behoben |

### Audit-Log

`audit_events`: `ts`, `actor_user_id`, `actor_ip`, `event`
(`auth.login`, `instance.updated`, `action.run` …), `target_type`,
`target_id`, `instance_id`, `details_json` (nie Secrets), `result`.
Persistent (Unterschied zum Ringpuffer im Altcode), Aufbewahrung Standard
365 Tage, Filter und Export als CSV/JSON.

### Boards

`boards`: `id`, `user_id`, `name`, `position`, `layouts_json`
(`{ lg: […], md: […], sm: […] }`, je Eintrag Widget-Typ, Instanz,
Position, Größe S/M/L/XL, Einstellungen), `version`, `updated_at`.
Vorlagen liegen im Code; Export/Import nutzt dasselbe JSON-Schema.

### Migrationen

- Kern: `drizzle-kit generate` erzeugt versionierte SQL-Dateien, die beim
  Start in einer Transaktion laufen. Jede Migration hat einen Test, der eine
  Datenbank im Vorgängerstand anlegt und hochmigriert.
- Plugins: eigene SQL-Dateien im Plugin-Paket, ausgeführt vom Kern-Migrator
  mit eigener Versionsspalte je Plugin; Tabellennamen müssen mit `p_<id>_`
  beginnen (geprüft).
- Vor jeder Migration legt der Kern eine Sicherung per SQLite-`VACUUM INTO`
  an (`/data/backups/pre-migration-<version>.db`).

### Import aus v1 (Phase 9)

Ein Kommando `rxf import-v1 --db <pfad> --env <pfad>` liest die alte Datei
**nur lesend** (`?mode=ro`), überführt ENV und `app_settings` in
Plugin-Instanzen (Secrets verschlüsselt) und `probe_history`/
`service_incidents` in Uptime-Serien und Alarmhistorie (Abbildung in
`docs/integrations/uptime.md`). Konten werden nicht übernommen (ADR 0001).

## Folgen

- Plugin-Daten, die nicht ins Kernmodell passen (z. B. PBS-Snapshots,
  Anruflisten), liegen in `attrs_json` oder in `p_<id>_*`-Tabellen.
- Die Datenbankdatei heißt anders als in v1 (`rxf-admin-v2.db`), damit eine
  Verwechslung beim Backup ausgeschlossen ist.
- `docs/OPERATIONS.md` beschreibt Backup (`.backup`/`VACUUM INTO` plus
  separater Sicherung des Master-Schlüssels, ADR 0006) und Restore.
