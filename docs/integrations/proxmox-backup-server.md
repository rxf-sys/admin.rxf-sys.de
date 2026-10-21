# Proxmox Backup Server (`proxmox-backup-server`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick
- Kategorie: Backup
- Zweck: Datastore-Belegung samt Voll-Prognose, letzte erfolgreiche Sicherung je Gast, Status von Verify, Prune und GC sowie fehlgeschlagene Tasks. Daraus ergibt sich die Antwort auf „Was ist überfällig?“.
- Versionen: Ziel ist **PBS 4.x**. PBS 4.0 erschien am 06.08.2025 auf Basis von Debian 13, mit S3-Backend als Technology Preview [S]. PBS 3 teilt das EOL-Datum von PVE 8 (08/2026) [S] und läuft nur best effort mit.
- Nur lokale REST-API (`https://<host>:8007/api2/json`), keine Cloud. Ein Plugin-Exemplar = ein PBS-Host (mehrere Datastores und Namespaces möglich).

## Verbindung & Auth
- Auth per API-Token, Header `Authorization: PBSAPIToken=<user@realm!tokenname>:<secret>` [D user-management.rst: Methode `PBSAPIToken`, Wert `TOKENID:TOKENSECRET`]. Der Server akzeptiert `=` oder Leerzeichen nach dem Präfix. Er trennt am ersten `:` und percent-decodiert das Secret [D proxmox-auth-api]. Der offizielle Client sendet `PBSAPIToken <id>:<secret>` [D http_client.rs]. **Anders als bei PVE** steht vor dem Secret `:` statt `=` [A `clients/pbs.py:16`].
- Keine Session. Tickets und CSRF gelten nur für Cookie-Logins [D proxmox-auth-api]. Ein Token-Ablauf erscheint als Spalte `expire` [D], wie man ihn setzt, ist nicht dokumentiert [?].
- Port 8007, Antworten im Envelope `{ "data": … }` [A `pbs.py:21,27`]. Als Knotenname in Pfaden wird `localhost` verwendet [?]. Die Task-Liste liefert immer `node = "localhost"` [D tasks.rs].
- TLS: Standardmäßig selbstsigniert (`/etc/proxmox-backup/proxy.pem`). Den Fingerprint zeigen das Dashboard („Show Fingerprint“) und `proxmox-backup-manager cert info` [S]. Mit `Sys.Audit` auf `/system/status` liefert ihn auch `GET /nodes/localhost/status` (`info.fingerprint`) [D]. Er ändert sich bei Zertifikatserneuerung [S], dann greift der Pin-Mismatch-Ablauf. Pinning per TOFU ist der übliche Proxmox-Weg (PVE pinnt PBS genauso).
- Entwurf `configSchema`:

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `host` | string | ja | nein | „IP oder Hostname des PBS“ |
| `port` | int, default 8007 | nein | nein | – |
| `tokenId` | string, Muster `user@realm!name` | ja | nein | „z. B. `rxf-dashboard@pbs!monitor`“ |
| `tokenSecret` | string (UUID) | ja | ja | „Wird nur einmal angezeigt.“ |
| `tlsFingerprint` | string (SHA-256, `AA:BB:…`) | bei selbstsigniert | nein | „Dashboard → Show Fingerprint“ |
| `datastores` | string[], optional | nein | nein | „Leer = alle Datastores, die das Token sieht.“ |
| `namespaces` | string[], optional + `recursive` bool | nein | nein | „Leer = alle Namespaces.“ |
| `overdueHours` | int, default 26 | nein | nein | „Ab wann eine Gruppe als überfällig gilt.“ |
| `overdueOverrides` | Map `ns/type/id` → Stunden \| `ignore` | nein | nein | „Pro Gast abweichend, z. B. wöchentliche Sicherung.“ |
| `linkedPveInstance` | Referenz auf `proxmox-ve`-Exemplar, optional | nein | nein | „Für Gast-Zuordnung, ‚nie gesichert‘ und verwaiste Gruppen.“ |
| `actionsEnabled` | boolean, default `false` | nein | nein | „Verify braucht deutlich mehr Rechte (siehe unten).“ |

## Minimale Rechte
Grundregel: PBS-Tokens haben **immer** eigene ACLs. Die effektiven Rechte sind die Schnittmenge aus Token- und Benutzer-ACL [D user-management.rst]. Benutzer **und** Token brauchen also die Rolle. Die Rollen sind fest im Code, **eigene Rollen gibt es nicht** [D pbs-api-types `acl.rs`: Role-Enum]. Gültige ACL-Pfade sind u. a. `/datastore/{store}[/{ns}]` und `/system/{tasks,status,…}` [D pbs-config `acl.rs`].

### Nur lesen
| Pfad | Rolle (Privilegien) | Wozu | Pflicht? | Quelle |
|---|---|---|---|---|
| `/datastore/<store>` (oder `/datastore` für alle) | `DatastoreAudit` (`Datastore.Audit`) | Datastore-Liste, `datastore-usage`, Status, RRD, Namespaces, Gruppen, Snapshots, GC-Status, Status von Verify- und Prune-Jobs | ja | [D] |
| `/system/tasks` | `Audit` (`Sys.Audit` + `Datastore.Audit`) | **fremde** Tasks lesen. Backups laufen unter dem PVE-Token, nicht unter unserem, sonst sind sie unsichtbar | empfohlen | [D tasks.rs] |
| `/system/status` | `Audit` | Host-CPU, RAM, rootfs, Fingerprint | optional | [D node/status.rs] |

**Korrektur zum Brief:** `DatastoreAudit` ist korrekt geschrieben (Rolle `DatastoreAudit`, Privileg `Datastore.Audit`). Allein reicht es aber nicht für „fehlgeschlagene Tasks“. Ohne `Sys.Audit` auf `/system/tasks` sieht ein Token nur eigene Tasks. Backup-Tasks werden über keine Datastore-Rechte freigegeben, nur Verify-, Sync-, GC- und Prune-Jobs über `Datastore.Verify`/`Modify` [D tasks.rs]. Status und Ergebnis der Verify-, Prune- und GC-*Jobs* sind mit `Datastore.Audit` über `/admin/{verify,prune,gc}` lesbar [D].

### Zusätzlich für Aktionen
| Aktion | Privileg | Kleinste eingebaute Rolle | Problem |
|---|---|---|---|
| Snapshot/Gruppe verifizieren, Verify-Job starten | `Datastore.Verify` [D] | `DatastoreReader` = Audit + Verify + **Read** [D] | `Datastore.Read` erlaubt das Lesen und Wiederherstellen **aller** Backup-Inhalte. Das Risiko ist hoch. |
| Prune-Job starten, GC starten | `Datastore.Modify` [D] | `DatastoreAdmin` | `Modify` erlaubt auch das Löschen von Snapshots, deshalb **nicht empfohlen** |

Der Altcode empfiehlt „eine eigene Rolle mit `Datastore.Verify`“ [A `docs/SETUP.md:77-81`]. Das ist auf PBS **nicht möglich**. Empfehlung: Verify bleibt Aufgabe geplanter Verify-Jobs in PBS. Die Dashboard-Aktion ist optional und nur mit ausdrücklicher Zustimmung zu `DatastoreReader`.

### Anleitung: Token anlegen (für den Onboarding-Assistenten)
1. Benutzer anlegen: *Configuration → Access Control → User Management → Add*, Realm `pbs`, Name `rxf-dashboard` (CLI: `proxmox-backup-manager user create rxf-dashboard@pbs` [D]). `[Screenshot: User Management → Add]`
2. Token anlegen: *Configuration → Access Control → API Token → Add* [?], Benutzer `rxf-dashboard@pbs`, Name `monitor`. Das Secret sofort kopieren (CLI: `proxmox-backup-manager user generate-token rxf-dashboard@pbs monitor`, Ausgabe `tokenid` + `value` [D]). `[Screenshot: Token-Secret-Dialog]`
3. Rechte für den **Benutzer**: *Configuration → Access Control → Permissions → Add → User Permission* [D Pfad], Pfad `/datastore/<store>`, Rolle `DatastoreAudit`. `[Screenshot: Permission-Dialog]`
4. Dieselbe Rolle für das **Token**: *Add → API Token Permission* (CLI: `proxmox-backup-manager acl update /datastore/<store> DatastoreAudit --auth-id 'rxf-dashboard@pbs!monitor'` [D Syntax]).
5. Empfohlen: Rolle `Audit` auf `/system/tasks` für Benutzer und Token (fehlgeschlagene Backups).
6. Prüfen: `proxmox-backup-manager user permissions 'rxf-dashboard@pbs!monitor' --path /datastore/<store>` [D]. Fingerprint im Dashboard per „Show Fingerprint“ ablesen und im Assistenten vergleichen.
7. Doku-Links: https://pbs.proxmox.com/docs/user-management.html (API Tokens, Access Control) [S], https://pbs.proxmox.com/docs/pve-integration.html (Fingerprint) [S].

## Fähigkeitsmatrix
### Daten
| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Datastores (`store`, `comment`, `maintenance`) | `GET /admin/datastore` | StoragePool | 10 min / 1 h | [D datastore.rs] |
| Belegung, **Voll-Prognose** `estimated-full-date`, `history` + `history-start`/`history-delta`, `gc-status`, `error` | `GET /status/datastore-usage` | StoragePool, Metric | 60 s / 10 min | [D status.rs], [A `pbs.py:161`] |
| Datastore-Status mit Zählern (`verbose=1`) | `GET /admin/datastore/{store}/status` | StoragePool | 15 min | [D] |
| Datastore-RRD | `GET /admin/datastore/{store}/rrd?timeframe=…` | Metric | bei Bedarf | [D] Endpunkt, Werte für `timeframe`/`cf` [?] |
| Namespaces (`ns`, `comment`) | `GET /admin/datastore/{store}/namespace[?parent&max-depth]` | – | 1 h | [D namespace.rs] |
| **Letzte Sicherung je Gast** (`backup-type`, `backup-id`, `last-backup`, `backup-count`, `owner`, `comment`, `files`) | `GET /admin/datastore/{store}/groups?ns=…` | Backup | 2 min / 15 min | [D datastore.rs, datastore types] |
| Snapshots (`backup-time`, `verification{state,upid}`, `size`, `protected`, `owner`, `comment`, `fingerprint`, `files`) | `GET /admin/datastore/{store}/snapshots?ns&backup-type&backup-id` | Backup | Detailansicht / 30 min für den Verify-Abgleich | [D], [A `pbs.py:162-164`] |
| Verify-Jobs (`id`, `store`, `schedule`, `ignore-verified`, `outdated-after`, `next-run`, `last-run-state`, `last-run-upid`, `last-run-endtime`) | `GET /admin/verify[?store]` | Backup (Job) | 5 min / 30 min | [D verify.rs, jobs.rs] |
| Prune-Jobs (Config + `keep-*` + Laufstatus) | `GET /admin/prune[?store]` | Backup (Job) | 15 min / 1 h | [D prune.rs], [A `pbs.py:94-150`] |
| GC je Datastore (`upid`, `removed-bytes`, `pending-bytes`, `disk-bytes`, `disk-chunks`, `next-run`, `last-run-state`, `duration`) | `GET /admin/gc[?store]` bzw. `GET /admin/datastore/{store}/gc` | Backup (Job) | 15 min / 1 h | [D gc.rs, datastore types] |
| Fehlgeschlagene Tasks (`errors`, `typefilter`, `store`, `since`, `limit`) | `GET /nodes/localhost/tasks` | Alert | 2 min / 10 min | [D tasks.rs] |
| Task-Status / -Log | `GET /nodes/localhost/tasks/{upid}/status`, `…/log` | – | bei Bedarf | [D] Existenz/Rechte, Pfade [?] |
| Host-Status (CPU, RAM, Swap, rootfs, Load, Uptime, Kernel, Fingerprint) | `GET /nodes/localhost/status` (Audit `/system/status`) | Host | 30 s / 5 min, optional | [D node/status.rs] |
| Version (`version`, `release`, `repoid`) | `GET /version` | – | beim Test, 24 h | [D version.rs] |
| Eigene effektive Rechte | `GET /access/permissions` | – | beim Test, 24 h | [D access/mod.rs] |
| Sync-Jobs (Status) | `GET /admin/sync` | Backup (Job) | 15 min, optional | [D] Existenz, Felder [?] |

### Aktionen
Alle Aktionen sind standardmäßig aus (siehe Rechteproblem oben). Antwort ist eine UPID, das Ergebnis kommt über den Task-Status [D].

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Snapshot oder Gruppe verifizieren (`backup-type`, `backup-id`, `backup-time`, `ns`, `ignore-verified`, `outdated-after`) | `POST /admin/datastore/{store}/verify` | low (nur I/O-Last) | operator | `Datastore.Verify` → `DatastoreReader` | [D], [A `pbs.py:51-91`] |
| Verify-Job jetzt ausführen | `POST /admin/verify/{id}/run` | low | operator | `Datastore.Verify` | [D] |
| Prune-Job jetzt ausführen | `POST /admin/prune/{id}/run` | high (löscht Snapshots) | admin | `Datastore.Modify` | [D], nicht empfohlen |
| GC starten | `POST /admin/datastore/{store}/gc` | medium (lange I/O-Last) | admin | `Datastore.Modify` | [D], nicht empfohlen |

Audit-Text: „{user} hat Verify für {store}/{ns}/{type}/{id}[@{zeit}] gestartet, Task {upid}, Ergebnis {status}“.

### Widgets (Vorschlag)
| Widget | Inhalt | Größen |
|---|---|---|
| **Backups: Was ist überfällig?** | S: Anzahl überfällig + älteste. M: Top 5 mit Alter. L: Tabelle Gast/Gruppe, letzte Sicherung, Alter, Schwelle, Verify-Status. XL: zusätzlich 30-Tage-Heatmap | S, M, L, XL |
| Datastore-Belegung | Donut in %, „voll ca. am TT.MM.JJJJ“. M/L: 30-Tage-Verlauf aus `history` | S, M, L |
| Job-Gesundheit | Verify/Prune/GC/Sync: letzter Lauf, Ergebnis, nächster Lauf | M |
| Fehlgeschlagene Tasks | letzte Fehler mit Typ, Gruppe, Log-Link | M, L |
| Verify-Abdeckung | Anteil Snapshots `ok` / `failed` / nie bzw. veraltet verifiziert | S, M |

### Seiten (Vorschlag)
- **Datastores:** Belegung, Prognose, GC-Kennzahlen, Wartungsmodus.
- **Backup-Gruppen:** Tabelle mit Überfällig-Ampel, Filter nach Namespace und Typ, Link zum PVE-Gast.
- **Gruppen-Detail:** Snapshots mit Verify-Status, Größe, `protected`, Notizen, Verify-Aktion.
- **Jobs:** Verify, Prune, GC, Sync.
- **Tasks:** Liste mit Filtern, Log-Viewer.

### Alarmvorschläge
| Regel | Bedingung | Schwere |
|---|---|---|
| Backup überfällig | `now − last-backup` > Schwelle (Default 26 h). Ab 2× Schwelle crit | warn/crit |
| Gast nie gesichert | PVE-Gast ohne Gruppe (mit `linkedPveInstance`) oder PVE `not-backed-up` | warn |
| Datastore fast voll | Belegung > 80 % warn, > 90 % crit | warn/crit |
| Voll-Prognose nah | `estimated-full-date` − heute < 30 Tage warn, < 7 Tage crit (nur wenn Wert > now) | warn/crit |
| Verify fehlgeschlagen | Snapshot `verification.state = failed` | crit |
| Verify-Job fehlgeschlagen | `last-run-state` ≠ `OK` [?] | crit |
| Lange nicht verifiziert | keine `verification` oder Startzeit aus Verify-UPID älter als `outdated-after` bzw. 30 Tage | warn |
| Prune- oder GC-Job fehlgeschlagen / GC > 7 Tage nicht gelaufen | `last-run-state`, `last-run-endtime` | warn |
| Backup-Task fehlgeschlagen | Task `worker_type = backup`, Status ≠ OK (braucht `/system/tasks`) | crit |
| Datastore-Fehler / Wartung | `error` gesetzt bzw. `maintenance` gesetzt | crit / info |
| PBS nicht erreichbar | länger als 5 min | crit |

## Rate-Limits & Last
- Kein API-Rate-Limit dokumentiert [?]. Es gibt eine Route `/admin/traffic-control` [D]. Dass sie nur Backup- und Sync-Datenverkehr drosselt und nicht die API, ist unbestätigt [?].
- `snapshots` streamt alle Snapshots einer Gruppe bzw. eines Datastores und berechnet `size` aus den Dateien [D]. Auf großen Stores, HDDs und besonders auf S3-Backends (Request-Kosten) ist das teuer [?]. Der Altcode holt **alle** Snapshots alle 60 s [A `pbs.py:161-164`, `config.py:130`]. Neu: Übersicht aus `groups` (eine Zeile je Gruppe) und `snapshots` nur gezielt je Gruppe oder selten.
- `datastore-usage` liest RRD-Daten und ist günstig. Die Voll-Prognose rechnet PBS selbst per linearer Regression über Monats-RRD [D].
- Polling im Backup-Fenster drosseln ist nicht nötig. Ein toter PBS darf das PVE-Plugin nicht blockieren (getrennte Circuit-Breaker).

## Verbindungstest & Fehlercodes
Ablauf: TLS (Fingerprint) → `GET /version` → `GET /access/permissions` (eigene Rechte ohne Zusatzprivileg [D]) → `GET /admin/datastore` → Abgleich mit den konfigurierten Datastores.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | ECONNREFUSED / ETIMEDOUT | „PBS {host}:{port} nicht erreichbar (Port 8007?).“ |
| `TLS_UNTRUSTED` | selbstsigniert, kein Pin | „Zertifikat unbekannt. Fingerprint {sha256} mit ‚Show Fingerprint‘ im PBS-Dashboard vergleichen.“ |
| `TLS_PIN_MISMATCH` | Fingerprint ≠ Pin | „Zertifikat hat sich geändert (Erneuerung?). Nur nach Prüfung neu bestätigen.“ |
| `AUTH_FAILED` | HTTP 401 | „Token ungültig oder gelöscht.“ |
| `WRONG_HEADER` | 401 mit „no authentication credentials provided“ [S] | „Falsches Token-Format. PBS erwartet `PBSAPIToken`, kein PVE-Token.“ |
| `TOKEN_FORMAT` | „invalid token name“ / „failed to split API token header“ [S] | „Token-ID und Secret müssen mit `:` getrennt sein.“ |
| `WRONG_PRODUCT` | Port 8006 bzw. Antwort passt zu PVE [?] | „Das ist ein Proxmox VE, kein Backup Server.“ |
| `PERM_DATASTORE` | kein `Datastore.Audit` auf `/datastore/<store>` | „Token hat keine Leserechte auf Datastore {store}. Rolle DatastoreAudit für Benutzer **und** Token setzen.“ |
| `DATASTORE_NOT_FOUND` | Store fehlt in `/admin/datastore` | „Datastore {store} existiert nicht oder ist unsichtbar.“ |
| `TASKS_LIMITED` (Warnung) | kein `Sys.Audit` auf `/system/tasks` | „Fehlgeschlagene Backup-Tasks nicht sichtbar (Rolle Audit auf /system/tasks fehlt).“ |
| `DATASTORE_MAINTENANCE` (Warnung) | `maintenance` gesetzt | „Datastore {store} ist im Wartungsmodus.“ |
| `DATASTORE_ERROR` | `error` in `datastore-usage` | „Datastore {store} meldet einen Fehler: {error}“ |
| `VERSION_UNSUPPORTED` | `version` < 3 | „PBS {version} wird nicht unterstützt (empfohlen 4.x).“ |

## Eigenheiten & Stolperfallen
- **Fehlgeschlagene Backups hinterlassen keinen Snapshot** [?]. Erfolg erkennt man also nur am Snapshot (`last-backup`), Fehler an Tasks (PBS `backup` mit Recht auf `/system/tasks`, oder PVE-Task `vzdump` im `proxmox-ve`-Plugin). Der Altcode wertet „Verify failed“ als „Backup fehlgeschlagen“ [A `pbs.py:204`, `notify.py:204-212`]. Das vermischt zwei Dinge.
- **Verify-Status:** `VerifyState` kennt nur `ok` und `failed` [D datastore types]. Die Altcode-Zustände `old`/`outdated`/`queued`/`running` [A `pbs.py:30-48`] liefert PBS nicht. „Veraltet“ muss das Plugin selbst berechnen: Startzeit aus `verification.upid` gegen `outdated-after` des Verify-Jobs (Tage).
- **Voll-Prognose** `estimated-full-date` (Unix-Zeit): fehlt bei weniger als 7 Datenpunkten. Bei flacher Kurve ist sie `0` („in die Vergangenheit gesetzt, damit die GUI es erkennt“) [D status.rs]. Werte ≤ now heißen also „nicht absehbar“. Sinkende Belegung ergibt vermutlich ebenfalls ein Datum in der Vergangenheit [?].
- **Überfällig-Logik (Vorschlag):** Stufe 1 ist die feste Schwelle je Gruppe (Default 26 h, Overrides). Stufe 2 nutzt mit `linkedPveInstance` die PVE-Backup-Jobs (`/cluster/backup`: `schedule`, `next-run` [D]) und `not-backed-up` [D]. Gruppen ohne PVE-Gast gelten als „verwaist“ (info), nicht als überfällig.
- **Zuordnung Gast ↔ Gruppe:** `backup-type` `vm`↔`qemu`, `ct`↔`lxc`, `host` ohne Gast [D BackupType], `backup-id` = VMID. VMIDs mehrerer PVE-Cluster können kollidieren, die Namespaces trennen sie. Die Zuordnung ist also Namespace → PVE-Exemplar. Der Altcode vergleicht nur `backup-id == vmid` [A `system.py:158-181`].
- **Namespaces:** `groups` und `snapshots` arbeiten nicht rekursiv (FIXME im Code) [D]. Das Plugin muss erst `namespace` listen und dann je Namespace abfragen.
- `size` im Snapshot ist die Summe der Dateigrößen, **nicht** dedupliziert [D], [A `backups.py:158-160`]. Belegung je Gast nur als „logische Größe“ beschriften.
- Ein Token mit nur `Datastore.Backup` sieht nur eigene Gruppen [D]. `datastore-usage` liefert für Stores, auf die das Token nur über Namespaces zugreift, leere Einträge [D]. Das darf nicht als „0 % belegt“ erscheinen.
- **UPID** (PBS): `UPID:{node}:{pid}:{pstart}:{task_id}:{starttime}:{worker_type}:{worker_id}:{userid}:` [S], also ein Feld mehr als bei PVE. `worker_id` kann escapte Zeichen enthalten [?]. Deshalb immer URL-encodieren [A `BACKEND_AUDIT.md:76-82`].
- Bekannte `worker_type`-Werte: `backup`, `verificationjob`, `garbage_collection`, `prune`/`prunejob`, `syncjob` [D tasks.rs]. Weitere wie `verify`/`reader` [?].
- PBS läuft hier als VM 201 auf dem PVE-Host [A `clients/proxmox.py:23`]. PVE führt PBS zusätzlich als Storage mit `plugintype=pbs` in `/cluster/resources` [D]. Maßgeblich ist das PBS-Plugin.
- `externalId`: StoragePool `<store>`, Backup-Gruppe `<store>/<ns>/<type>/<id>`, Snapshot `…@<backup-time>`, Jobs `job/<kind>/<id>`.

## Wissen aus dem Altcode
| Erkenntnis | Fundstelle | Konsequenz für v2 |
|---|---|---|
| Header `PBSAPIToken=id:secret` funktioniert produktiv | [A `clients/pbs.py:14-17`] | übernehmen, bestätigt [D] |
| `verify=False` als Default | [A `config.py:68`] | Fingerprint-Pinning |
| Nur ein Datastore, nur Root-Namespace | [A `config.py:67`, `pbs.py:161-164`] | mehrere Stores und Namespaces |
| Default `backup` in `config.py` gegen `backups` in `.env.example` | [A `config.py:67`, `infrastructure/.env.example:61`] | Store-Namen aus `/admin/datastore` zur Auswahl anbieten |
| Alle Snapshots alle 60 s | [A `pbs.py:161-164,225-231`, `config.py:130`] | `groups` für die Übersicht, `snapshots` gezielt |
| `estimated-full-date` und `history` aus `datastore-usage` ungenutzt | [A `pbs.py:178-188`] | Prognose und Verlauf direkt nutzen [D] |
| Verify-Mapping mit nicht existierenden Zuständen | [A `pbs.py:30-48`] | nur `ok`/`failed` + eigene Alterungsregel |
| „Heute“-Zähler in UTC | [A `pbs.py:194`] | Zeitzone der Instanz (Europe/Berlin) |
| Prune-Plan über `/config/prune`, erster Job je Store | [A `pbs.py:94-150`, Tests `test_pbs.py:128-188`] | `/admin/prune` liefert Config + Laufstatus [D] |
| Verify-Aktion operator+, 403 wird zum Toast | [A `backups.py:32-78`, `test_rbac_writes.py:106-145`] | Rollenmodell übernehmen, Aktion optional |
| „Eigene Rolle mit Datastore.Verify“, ACL nur für den Benutzer | [A `docs/SETUP.md:71-81`] | falsch: Es gibt keine eigenen Rollen, und das Token braucht eine eigene ACL [D] |
| `backup_type` geprüft auf `vm\|ct\|host` | [A `backups.py:46-47`] | passt zum Enum [D] |
| Heatmap und Größe je Gast aus der Snapshot-Liste | [A `backups.py:81-185`] | als L/XL-Widget mit langsamem Refresh behalten |
| Wochenbericht nutzt nur „heute x/y Jobs“ | [A `weekly_report.py:60-86`] | ersetzen durch Überfällig-Zusammenfassung |
| `total or 1` gegen Division durch 0 | [A `pbs.py:181`] | `total=0` → Status `unknown` statt 0 % |

## Testbarkeit (Vertragstests)
- Kein OpenAPI. Das API-Schema steckt im Rust-Code (`#[api]`-Makros, `pbs-api-types` mit serde `kebab-case`) [D]. Die API-Viewer-Datei `apidata.js` wird beim Doku-Build erzeugt und ist nicht eingecheckt [D Verzeichnis], [?] ob unter `https://<pbs>:8007/docs/api-viewer/apidata.js` abrufbar.
- Altfixtures: 10 handgeschriebene `respx`-Tests [A `backend/tests/test_pbs.py`], plus RBAC [A `test_rbac_writes.py`]. Die Payloads sind minimal (keine `estimated-full-date`, keine Namespaces).
- Neue Fixtures aufzeichnen (Token per `curl` im Dashboard-LXC, Secrets, Hosts und Owner schwärzen): `datastore-usage` (mit und ohne Prognose, `0`), `groups` mit Namespaces, `snapshots` mit `verification ok/failed/null`, `/admin/{verify,prune,gc}`, Task-Liste mit Fehler, 401/403-Antworten, Wartungsmodus.

## Aufwand & Empfehlung
- Aufwand **M**: Die Lese-Endpunkte sind überschaubar und gut typisiert. Aufwand entsteht durch Überfällig-Logik, Namespace-Iteration, Zuordnung zu PVE-Gästen und Rechtediagnose. Aktionen sind optional und klein.
- Abhängigkeiten: TLS-Pinning-Baustein (gemeinsam mit PVE), optional `proxmox-ve` für Gast-Zuordnung und Backup-Pläne.
- Empfohlene Welle: **1**, direkt nach `proxmox-ve` (gleicher Pinning- und Task-Code). Zuerst nur lesend.

## Offene Punkte
- Verify-Aktion beibehalten? Dafür bräuchte das Token `DatastoreReader` und könnte damit alle Backup-Inhalte lesen. Alternative: nur geplante Verify-Jobs anzeigen.
- Ist Rolle `Audit` auf `/system/tasks` akzeptabel (sieht alle Tasks des PBS)?
- Default-Schwelle 26 h passend? Gibt es wöchentlich gesicherte Gäste?
- Werden Namespaces, mehrere Datastores, Sync oder Remote genutzt?
- Host-Kennzahlen des PBS gewünscht (Audit auf `/system/status`)? Sonst kommen sie aus dem PVE-Gast 201.
- Soll das PBS-Plugin die PVE-Backup-Jobs lesen (plugin-übergreifende Abhängigkeit im SDK)?

## Quellen
1. https://github.com/proxmox/proxmox-backup/blob/master/pbs-api-types/src/acl.rs – Privilegien, feste Rollen (DatastoreAudit, DatastoreReader, Audit …)
2. https://github.com/proxmox/proxmox-backup/blob/master/docs/user-management.rst – Token-Header `PBSAPIToken`, Schnittmenge, eigene ACLs nötig, CLI-Befehle, ACL-Pfade
3. https://github.com/proxmox/proxmox-rs/blob/master/proxmox-auth-api/src/api/mod.rs – Header-Parsing (`=`/Leerzeichen, Split an `:`, Percent-Decode)
4. https://github.com/proxmox/proxmox-backup/blob/master/pbs-client/src/http_client.rs – Client sendet `PBSAPIToken {id}:{secret}`
5. https://github.com/proxmox/proxmox-backup/blob/master/src/api2/status.rs – `datastore-usage`, `estimated-full-date`-Berechnung, `history`
6. https://github.com/proxmox/proxmox-backup/blob/master/src/api2/admin/datastore.rs – Datastore-Liste, groups, snapshots, status, verify, prune, gc, rrd, Owner-Logik
7. https://github.com/proxmox/proxmox-backup/blob/master/src/api2/admin/verify.rs, …/prune.rs, …/gc.rs, …/namespace.rs, …/mod.rs – Job-Status, Run-Endpunkte, Namespaces
8. https://github.com/proxmox/proxmox-backup/blob/master/pbs-api-types/src/jobs.rs – `JobScheduleStatus` (`next-run`, `last-run-state`, `last-run-upid`, `last-run-endtime`)
9. https://github.com/proxmox/proxmox-backup/blob/master/pbs-api-types/src/datastore.rs – `VerifyState` (ok/failed), `GroupListItem`, GC-Status, `BackupType`
10. https://github.com/proxmox/proxmox-backup/blob/master/src/api2/node/tasks.rs – Task-Sichtbarkeit (Sys.Audit `/system/tasks`), Filter
11. https://github.com/proxmox/proxmox-backup/blob/master/src/api2/node/status.rs – Host-Status, Fingerprint, Sys.Audit `/system/status`
12. https://github.com/proxmox/proxmox-backup/blob/master/src/api2/version.rs, …/src/api2/access/mod.rs – `/version`, `/access/permissions`
13. https://github.com/proxmox/proxmox-backup/blob/master/pbs-config/src/acl.rs – gültige ACL-Pfade
14. https://forum.proxmox.com/threads/proxmox-backup-server-4-0-released.169306/ – PBS 4.0 (06.08.2025), S3-Preview [S]
15. https://pbs.proxmox.com/docs/pve-integration.html – Fingerprint per Dashboard bzw. `cert info` [S]
16. https://forum.proxmox.com/goto/post?id=586423 – Fehlermeldungen bei falschem Header-Format [S]
17. https://lists.proxmox.com/pipermail/pbs-devel/2021-September/004088.html – UPID-Format von PBS [S]
18. https://endoflife.ai/article-proxmox-8-family-eol – PBS 3 EOL mit PVE 8 [S]
