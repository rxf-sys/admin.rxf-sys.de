# Proxmox VE (`proxmox-ve`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick
- Kategorie: Virtualisierung
- Zweck: Knoten, Gäste (QEMU-VMs und LXC), Storage, Tasks und RRD-Historie eines Proxmox-VE-Clusters (oder Einzelknotens) lesen, dazu optional Power-Aktionen und Snapshots.
- Versionen: Ziel ist **PVE 9.x**. PVE 9.0 erschien am 05.08.2025 [S], der Altcode-Testfixture nennt `9.1.9` [A `backend/tests/test_proxmox.py:27`]. PVE 8 ist seit 08/2026 EOL [S] und läuft nur best effort mit: Dort braucht Gast-Agent-Zugriff `VM.Monitor`, das in PVEAuditor fehlt. PVE 9 hat `VM.Monitor` entfernt und durch `VM.GuestAgent.*` ersetzt [S].
- Nur lokale REST-API (`https://<host>:8006/api2/json`), keine Cloud. **Ein Plugin-Exemplar = ein Cluster** (siehe Eigenheiten).

## Verbindung & Auth
- Auth per API-Token, Header `Authorization: PVEAPIToken=USER@REALM!TOKENID=UUID` [D pveum.adoc]. Trennzeichen vor dem Secret ist `=` (bei PBS dagegen `:`).
- Kein Login, keine Session. Token-Anfragen brauchen kein `CSRFPreventionToken` [S]. Lebensdauer: unbegrenzt oder über `expire` (Unix-Epoch) [D pveum.adoc]. Tickets (Cookie-Login, 2 h) nutzen wir nicht [S].
- Port 8006, Prefix `/api2/json`, Antworten im Envelope `{ "data": … }` [A `clients/proxmox.py:34,40`].
- TLS: Standardmäßig selbstsigniert. Knotenzertifikate (`pve-ssl.pem`) sind von der Cluster-CA `/etc/pve/pve-root-ca.pem` signiert, optional gibt es ein eigenes `pveproxy-ssl.pem` (z. B. ACME) [D Certificates.pm]. Fingerprint-Pinning (SHA-256 des Leaf-Zertifikats, TOFU) ist pro Endpunkt machbar. `GET /nodes` liefert `ssl_fingerprint` je Knoten [D Nodes.pm]: Nach dem ersten vertrauten Kontakt kann der Assistent die Fingerprints der übrigen Knoten **vorschlagen**, der Admin bestätigt sie. Alternative: die Cluster-CA pinnen. Ob die SANs der Standardzertifikate zur IP passen, ist unklar [?]. Der Altcode schaltet die TLS-Prüfung ganz ab [A `config.py:60`].
- Entwurf `configSchema`:

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `endpoints` | Array `{host, port=8006, fingerprint?}` (1–n) | ja | nein | „Mindestens ein Knoten. Mehrere Knoten desselben Clusters = Ausfallsicherheit.“ |
| `tokenId` | string, Muster `user@realm!tokenid` | ja | nein | „z. B. `rxf-dashboard@pve!monitor`“ |
| `tokenSecret` | string (UUID) | ja | ja | „Wird nur einmal beim Anlegen angezeigt.“ |
| `tlsMode` | enum `pin-leaf` \| `pin-ca` \| `system` | ja | nein | „Selbstsigniert: Fingerprint bestätigen (empfohlen).“ |
| `caPem` | string (PEM) | bei `pin-ca` | nein | „Inhalt von `/etc/pve/pve-root-ca.pem`“ |
| `actionsEnabled` | boolean, default `false` | nein | nein | „Aktionen brauchen zusätzliche Rechte (siehe unten).“ |
| `allowedActions` | Mehrfachauswahl `start/shutdown/reboot/stop/snapshot` | nein | nein | „Nur Aktionen, für die das Token Rechte hat.“ |
| `actionScope` | Liste VMIDs/Pools/Tags, optional | nein | nein | „Zusätzliche Einschränkung zur PVE-ACL (Defense in Depth).“ |
| `hideTemplates` | boolean, default `true` | nein | nein | „Vorlagen (`template=1`) ausblenden.“ |

## Minimale Rechte
Grundregel: Bei **Privilege Separation** (Standard für neue Tokens) gilt *Schnittmenge* aus Benutzer- und Token-ACL. Ein Token kann nie mehr als sein Benutzer [D pveum.adoc, RPCEnvironment.pm]. ACLs müssen also **für Benutzer UND Token** gesetzt sein. Einzelprivilegien lassen sich nicht direkt vergeben, nur Rollen (eingebaut oder eigene) [D pveum.adoc].

### Nur lesen
Rolle `PVEAuditor` = alle `audit`-Privilegien: `VM.Audit`, `VM.GuestAgent.Audit`, `Sys.Audit`, `Datastore.Audit`, `SDN.Audit`, `Pool.Audit`, `Mapping.Audit` [D AccessControl.pm]. Die Rolle hat keine Schreibrechte.

| Pfad | Wozu | Quelle |
|---|---|---|
| `/` (Sys.Audit) | `/cluster/status`, `/cluster/backup`, `/cluster/backup-info/not-backed-up`, `/cluster/ha/status/current`, `/cluster/metrics/export`, alle Tasks in `/cluster/tasks`, `disks/smart` | [D] |
| `/nodes` (Sys.Audit) | `/nodes/{node}/status`, `rrddata`, `disks/list`, alle Tasks des Knotens | [D] |
| `/vms` (VM.Audit, VM.GuestAgent.Audit) | Gästeliste, `status/current`, `rrddata`, Snapshot-Liste, LXC-`interfaces`, Agent `network-get-interfaces` | [D] |
| `/storage` (Datastore.Audit) | Storage in `/cluster/resources` und `/nodes/{node}/storage` | [D] |
| `/pool` (Pool.Audit) | optional, nur für Pool-Gruppierung | [D] |

- **Variante A (empfohlen, einfach):** `PVEAuditor` auf `/` mit Propagate, für Benutzer und Token.
- **Variante B (enger):** `PVEAuditor` mit Propagate auf `/nodes`, `/vms`, `/storage` (optional `/pool`), dazu `PVEAuditor` auf `/` **ohne** Propagate. So gibt es kein `Sys.Audit` auf `/access` (Benutzer- und ACL-Listen), `/sdn` oder `/mapping`.
- **Bewusst nicht enthalten:** `Sys.Syslog` (für `/nodes/{node}/journal` und `syslog`) [D Nodes.pm] und `Sys.Modify` (für `/nodes/{node}/apt/update`) [D APT.pm]. Ein „Updates verfügbar“-Widget ist damit nur mit Schreibrechten möglich und wird **nicht** umgesetzt.

### Zusätzlich für Aktionen
| Aktion(en) | Privileg | Empfohlene Rolle | Pfad | Hinweis |
|---|---|---|---|---|
| start, shutdown, reboot, stop | `VM.PowerMgmt` [D] | eigene Rolle `RxfGuestPower` (nur `VM.PowerMgmt`) | `/vms`, `/vms/<vmid>` oder `/pool/<pool>` | `PVEVMUser` enthält zusätzlich `VM.Console`, `VM.Backup`, `VM.GuestAgent.FileRead/FileWrite` und ist zu breit [D] |
| snapshot (erstellen) | `VM.Snapshot` [D] | eigene Rolle `RxfGuestSnapshot` | wie oben | **Korrektur zum Brief:** `VM.PowerMgmt` reicht nicht. `VM.Snapshot` gehört zur `admin`-Gruppe, `PVEVMUser` enthält es nicht. Es erlaubt außerdem **Löschen und Rollback** von Snapshots (Rollback prüft `VM.Snapshot` *oder* `VM.Snapshot.Rollback`) [D Qemu.pm, LXC/Snapshot.pm]. |
| snapshot mit `vmstate` (nur QEMU) | `VM.Snapshot` | – | – | Im Handler gibt es keine Zusatzprüfung für den RAM-State [D]. Ob tiefer im Code `Datastore.AllocateSpace` geprüft wird, ist offen [?] |

Pool-ACLs gelten für alle Gäste im Pool, propagieren aber nie [D RPCEnvironment.pm]. So lassen sich Aktionen auf eine Pool-Auswahl begrenzen.

### Anleitung: Token anlegen (für den Onboarding-Assistenten)
1. Benutzer anlegen: *Datacenter → Permissions → Users → Add*, Realm `pve`, Name `rxf-dashboard` (CLI: `pveum user add rxf-dashboard@pve -comment "admin.rxf-sys.de"` [D]). `[Screenshot: Users → Add]`
2. Token anlegen: *Datacenter → Permissions → API Tokens → Add*, Token-ID `monitor`, **Privilege Separation an**, optional Ablaufdatum. Das Secret sofort kopieren, es wird nur einmal gezeigt (CLI: `pveum user token add rxf-dashboard@pve monitor -privsep 1` [D]). `[Screenshot: Token-Dialog mit Secret]`
3. Leserechte für den **Benutzer**: *Permissions → Add → User Permission*, Pfad `/`, Rolle `PVEAuditor` (Variante A). `[Screenshot: User Permission]`
4. Dieselben Rechte für das **Token**: *Permissions → Add → API Token Permission*, Pfad `/`, Rolle `PVEAuditor` (CLI: `pveum acl modify / -token 'rxf-dashboard@pve!monitor' -role PVEAuditor` [D]). `[Screenshot: API Token Permission]`
5. Nur wenn Aktionen gewünscht sind: Rolle anlegen mit `pveum role add RxfGuestPower --privs "VM.PowerMgmt"` [D Syntax], dann ACL auf `/vms` (oder Pool) für Benutzer **und** Token setzen.
6. Prüfen: `pveum user token permissions rxf-dashboard@pve monitor` [D]. Danach im Assistenten „Verbindung testen“ und den Fingerprint bestätigen.
7. Doku-Links: https://pve.proxmox.com/pve-docs/chapter-pveum.html (Abschnitt API Tokens) [S], https://pve.proxmox.com/wiki/Proxmox_VE_API [S].

## Fähigkeitsmatrix
### Daten
| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Cluster-Übersicht: Knoten, Gäste, Storage in **einem** Aufruf (`cpu`, `maxcpu`, `mem`, `memhost`, `maxmem`, `disk`, `maxdisk`, `netin/out`, `diskread/write`, `uptime`, `status`, `node`, `vmid`, `name`, `template`, `tags`, `lock`, `hastate`, `pool`, `plugintype`, `shared`) | `GET /cluster/resources[?type=vm\|storage\|node]` | Host, Guest, StoragePool | 10 s / 60 s | [D Cluster.pm] |
| Cluster/Quorum, Knoten online, IP, Knoten-ID, Clustername | `GET /cluster/status` (Sys.Audit `/`) | Host | 15 s / 60 s | [D] |
| Knotendetails: CPU-Modell/-Kerne, Load, RAM, Swap, rootfs, Uptime, `pveversion`, Kernel, Boot-Modus | `GET /nodes/{node}/status` (proxyto) | Host | 15 s / 120 s (nur Online-Knoten) | [D Nodes.pm], [A `proxmox.py:89`] |
| Version des antwortenden Knotens | `GET /version` | – | beim Test, 24 h | [A `proxmox.py:90`] |
| RRD-Historie Knoten (`timeframe` hour…decade, `cf` AVERAGE/MAX) | `GET /nodes/{node}/rrddata` | Metric | bei Bedarf, Cache 1–30 min | [D] |
| RRD-Historie Gast (`timeframe` hour…year) | `GET /nodes/{node}/{qemu\|lxc}/{vmid}/rrddata` | Metric | bei Bedarf | [D Qemu.pm, LXC.pm] |
| RRD-Historie Storage | `GET /nodes/{node}/storage/{storage}/rrddata` | Metric | bei Bedarf | [D] |
| Rohmetriken ganzer Cluster (`history`, `start-time`, `node-list`) | `GET /cluster/metrics/export` (Sys.Audit `/`) | Metric | 60 s (inkrementell über `start-time`) | [D MetricServer.pm], ab welcher Version [?] |
| Gast-Detail (QEMU: `qmpstatus`, `ha`, `agent`, Speicher) | `GET /nodes/{node}/{qemu\|lxc}/{vmid}/status/current` | Guest | nur Detailansicht, 10 s | [D], [A `proxmox.py:180-211`] |
| Gast-IP LXC (live, auch bei DHCP) | `GET /nodes/{node}/lxc/{vmid}/interfaces` | Guest | 10 min / bei Bedarf | [D LXC.pm] |
| Gast-IP QEMU (Agent) | `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` (`VM.GuestAgent.Audit`) | Guest | 10 min / bei Bedarf | [D Agent.pm], [A `proxmox.py:165-172`] |
| Storage-Status je Knoten (`active`, `enabled`, `used_fraction`, `content`) | `GET /nodes/{node}/storage` | StoragePool | 60 s / 5 min | [D Storage/Status.pm] |
| Tasks clusterweit (letzte) | `GET /cluster/tasks` | Alert (Fehlertasks) | 15 s / 120 s | [D] |
| Tasks je Knoten, gefiltert (`vmid`, `errors`, `typefilter`, `since`, `statusfilter`, `limit`) | `GET /nodes/{node}/tasks` | Alert | 5 min | [D Tasks.pm], [A `proxmox.py:348-372`] |
| Task-Status / Task-Log (`n`, `t`) | `GET /nodes/{node}/tasks/{upid}/status`, `…/log?start&limit` | – | bei Bedarf | [D], [A `proxmox.py:286-308`] |
| Snapshots je Gast | `GET /nodes/{node}/{qemu\|lxc}/{vmid}/snapshot` | Guest (Plugin-Daten) | Detailansicht, 6 h für Alter-Alarm | [D] |
| Gäste ohne Backup-Job | `GET /cluster/backup-info/not-backed-up` (Sys.Audit `/`) | Backup (Lücke) | 1 h | [D BackupInfo.pm] |
| Backup-Jobs (`schedule`, `next-run`, `enabled`) | `GET /cluster/backup` (Sys.Audit `/`) | Backup (Erwartung) | 1 h | [D Backup.pm] |
| HA-Status (Quorum, Master, LRM, Services) | `GET /cluster/ha/status/current` (Sys.Audit `/`) | Host/Guest | 30 s / 5 min, nur wenn HA genutzt | [D pve-ha-manager] |
| Disks inkl. SMART-Health | `GET /nodes/{node}/disks/list` (Default `skipsmart=0`) | Host (Plugin-Daten) | 6 h | [D Disks.pm], [A `proxmox.py:101-130`] |
| Knoten-Zertifikate | `GET /nodes/{node}/certificates/info` | Certificate | 24 h | [D] Endpunkt, Feldnamen [?] |
| Eigene effektive Rechte | `GET /access/permissions` | – | beim Test, 24 h | [D AccessControl.pm (API2)] |

### Aktionen
Alle Aktionen sind asynchron und liefern eine UPID [D]. Das Plugin fragt `tasks/{upid}/status` ab, bis `status=stopped` erreicht ist. Erfolg nur bei `exitstatus=OK`. Den Knoten liest es aus der UPID (2. Feld), nicht aus der Konfiguration.

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Start | `POST /nodes/{node}/{qemu\|lxc}/{vmid}/status/start` | low | operator | `VM.PowerMgmt` | [D] |
| Herunterfahren (sauber, `timeout`, `forceStop=0`) | `POST …/status/shutdown` | medium | operator | `VM.PowerMgmt` | [D] |
| Neustart (`timeout`) | `POST …/status/reboot` | medium | operator | `VM.PowerMgmt` | [D], [A `proxmox.py:412-444`] |
| Hart stoppen (`overrule-shutdown` optional) | `POST …/status/stop` | high | admin | `VM.PowerMgmt` | [D] |
| Snapshot erstellen (`snapname`, `description`, QEMU optional `vmstate`) | `POST /nodes/{node}/{qemu\|lxc}/{vmid}/snapshot` | low (ohne `vmstate`), medium (mit `vmstate`) | operator | `VM.Snapshot` (erlaubt auch Löschen und Rollback) | [D] |

Audit-Text-Muster: „{user} hat {aktion} für {name} ({type}/{vmid}) auf {node} ausgelöst, Task {upid}, Ergebnis {exitstatus}“. Jede Aktion braucht einen Bestätigungsdialog. `stop` verlangt zusätzlich die Eingabe des Gastnamens.

### Widgets (Vorschlag)
| Widget | Inhalt | Größen |
|---|---|---|
| Knotenauslastung | CPU/RAM/rootfs je Knoten, online/offline. L: mit 1-h-RRD-Sparkline | S (1 Knoten), M, L |
| Top-Verbraucher | Top-N Gäste nach CPU, RAM, Disk-I/O oder Netz (aus `/cluster/resources`) | M, L |
| Gaststatus | Zähler running/stopped/unknown, Liste mit Status-Punkt | S, M, L |
| Storage-Belegung | Balken je Storage, shared dedupliziert, inaktive rot | S, M, L |
| Cluster-Gesundheit | Quorum, Knoten online x/y, HA-Fehler | S |
| Fehlgeschlagene Tasks | letzte Fehlertasks (z. B. `vzdump`) mit Log-Link | M, L |
| Ohne Backup | Gäste ohne Backup-Job | S, M |

### Seiten (Vorschlag)
- **Cluster:** Knotenkarten, Quorum, HA, Storage-Tabelle.
- **Knoten-Detail:** Status, RRD-Charts (Stunde/Tag/Woche/Monat), Disks/SMART, Tasks, Zertifikate.
- **Gäste:** filter- und sortierbare Tabelle (Typ, Knoten, Tags, Pool, Status).
- **Gast-Detail:** Status, RRD-Charts, IPs, Snapshots, Tasks mit Task-Log, Backups (Querverweis auf `proxmox-backup-server`), Aktionen.
- **Tasks:** clusterweite Liste mit Filtern, Log-Viewer.

### Alarmvorschläge
| Regel | Bedingung | Schwere |
|---|---|---|
| Knoten offline | `/cluster/status` `online=0` länger als 2 min | crit |
| Kein Quorum | `type=cluster` `quorate=0` | crit |
| Knoten-CPU hoch | `cpu` > 0,9 über 10 min | warn |
| Knoten-RAM hoch | `mem/maxmem` > 0,9 über 10 min | warn |
| Storage fast voll | `disk/maxdisk` > 0,85 → warn, > 0,95 → crit | warn/crit |
| Storage inaktiv | `enabled=1` und `active=0` | crit |
| Gast unerwartet gestoppt | running → stopped, ohne eigene Aktion und ohne Task des Nutzers | warn |
| Backup-Task fehlgeschlagen | Task `vzdump` mit Status ≠ `OK` | crit |
| Gast ohne Backup-Job | Eintrag in `not-backed-up` | warn |
| HA-Service im Fehlerzustand | `/cluster/ha/status/current` `state=error` [?] | crit |
| Alter Snapshot | Snapshot älter als 14 Tage (frisst Thin-Pool) | warn |
| Disk-SMART | `health` ≠ `PASSED`/`OK` | crit |
| Zertifikat läuft ab | `notafter` < 14 Tage [?] | warn |

## Rate-Limits & Last
- Kein dokumentiertes API-Rate-Limit gefunden [?]. `pvestatd` aktualisiert Status und RRD fest alle 10 s [S]. Schnelleres Polling als 10 s bringt also nichts.
- `/cluster/resources` liest nur lokal aus pmxcfs bzw. `rrd_dump` und spricht keinen anderen Knoten an [D Cluster.pm]. Es ist die günstigste Hauptquelle und ersetzt die N+1-Abfragen des Altcodes (pro Gast `config` + Agent + `status/current` alle 15 s [A `proxmox.py:236-243`, `config.py:127`]).
- Endpunkte mit `proxyto => 'node'` (Knotenstatus, Tasks, Storage, Gast-Status) belasten einen zweiten Knoten. Für Offline-Knoten **nicht** aufrufen.
- `disks/list` startet standardmäßig SMART-Abfragen [D]. Deshalb nur selten abfragen (6 h). Ob dabei schlafende HDDs aufwachen, ist offen [?].
- Agent-Abfragen hängen bei toten Agents bis zum Timeout. Deshalb nur für laufende Gäste mit `agent`-Flag, mit kurzem Timeout (3 s) und gecacht.

## Verbindungstest & Fehlercodes
Ablauf: TLS-Handshake (Fingerprint) → `GET /version` → `GET /access/permissions` (eigene Rechte, ohne Zusatzprivileg [D]) → `GET /cluster/status` → Abgleich der Rechte mit den aktivierten Funktionen.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH | „Host {host}:{port} nicht erreichbar. Läuft `pveproxy`, stimmt der Port (8006)?“ |
| `DNS_FAILED` | ENOTFOUND | „Hostname {host} lässt sich nicht auflösen.“ |
| `TLS_UNTRUSTED` | selbstsigniert, noch kein Pin | „Zertifikat unbekannt. Fingerprint {sha256} prüfen und bestätigen.“ |
| `TLS_PIN_MISMATCH` | Fingerprint ≠ Pin | „Zertifikat hat sich geändert (erneuert oder MITM?). Neu bestätigen nur nach Prüfung.“ |
| `AUTH_FAILED` | HTTP 401 | „Token ungültig, abgelaufen oder Format falsch (erwartet `user@realm!id` + UUID).“ |
| `PRIVSEP_NO_ACL` | `/access/permissions` leer | „Token hat Privilege Separation, aber keine eigenen Rechte. ACL auch für das Token setzen.“ |
| `PERM_NODES` | kein `Sys.Audit` auf `/nodes` | „Token hat keine Leserechte auf /nodes.“ |
| `PERM_VMS` | kein `VM.Audit` auf `/vms` | „Token sieht keine Gäste (VM.Audit auf /vms fehlt).“ |
| `PERM_STORAGE` | kein `Datastore.Audit` auf `/storage` | „Token sieht keinen Storage (Datastore.Audit fehlt).“ |
| `PERM_ROOT` (Warnung) | kein `Sys.Audit` auf `/` | „Cluster-Status, HA und Backup-Jobs nicht lesbar (Sys.Audit auf / fehlt).“ |
| `PERM_ACTIONS` | Aktion aktiv, Privileg fehlt | „Aktionen aktiviert, aber `VM.PowerMgmt`/`VM.Snapshot` fehlt.“ |
| `NODE_PROXY_FAILED` | HTTP 595/596 bei `proxyto`-Aufruf [S] | „Knoten {node} antwortet dem Cluster nicht (offline?).“ |
| `NO_QUORUM` (Warnung) | `quorate=0` | „Cluster ohne Quorum. Lesen geht, Aktionen schlagen fehl.“ [?] |
| `DUPLICATE_CLUSTER` | Clustername schon in anderem Plugin-Exemplar | „Dieser Cluster ist bereits eingebunden.“ |
| `VERSION_UNSUPPORTED` | `version` < 8 | „PVE {version} wird nicht unterstützt (mind. 8, empfohlen 9).“ |

## Eigenheiten & Stolperfallen
- **Cluster = ein Exemplar.** Jeder Knoten beantwortet `/cluster/resources`, `/cluster/tasks` und `/cluster/status` für den ganzen Cluster [D]. Zwei Exemplare für zwei Knoten desselben Clusters liefern doppelte Gäste. Mehrere `endpoints` dienen nur dem Failover: Der Client bleibt beim letzten gesunden Endpunkt, mit Circuit-Breaker je Endpunkt. Die Knoten-IPs aus `/cluster/status` (`ip`) nie automatisch als Ziele übernehmen (SSRF), höchstens vorschlagen.
- **Knoten ausgefallen:** `/cluster/status` zeigt `online=0`, `/cluster/resources` zeigt den Knoten als `offline` [D API2Tools.pm]. Gäste dieses Knotens behalten den Status aus dem letzten RRD-Eintrag, eine Alterungsprüfung gibt es nicht [D]. Das Plugin muss sie selbst auf `unknown` setzen. Collectors mit `proxyto` überspringen den Knoten, Aktionen für seine Gäste sind gesperrt. Fällt der *konfigurierte* Endpunkt aus, greift das Failover. Ohne zweiten Endpunkt ist alles `unknown`, auch die anderen Plugins bleiben unberührt.
- Den Knotennamen nie fest konfigurieren (Altcode: `PROXMOX_NODE=rxf-sys` [A `config.py:57`]). Er kommt aus `/cluster/resources` (`node`) bzw. der UPID.
- **UPID** hat die Form `UPID:node:pid:pstart:starttime:type:id:user:` (Hex-Felder) [S]. Im Pfad immer URL-encodieren [A `BACKEND_AUDIT.md:76-82`, `proxmox.py:293`].
- **RAM von VMs:** Unter PVE 9 ist `mem` die Sicht des Gasts (wenn er Balloon-Statistiken meldet), `memhost` die Host-Sicht (PSS aller Prozesse der cgroup) [S, Feld `memhost` D]. Werte über 100 % sind möglich [S]. Der Altcode-Workaround über `status/current` [A `proxmox.py:180-211`] ist unter PVE 9 vermutlich überflüssig. Trotzdem auf `maxmem` begrenzen.
- `disk` ist für QEMU-VMs ohne Agent wohl 0 (Gast-Dateisystem unbekannt) [?].
- HA-verwaltete Gäste: start/stop/shutdown werden zu `ha-manager`-Anfragen (Tasks `hastart`/`hastop`) [D]. `stop` mit `overrule-shutdown` wird abgelehnt [D]. Das Ende des Tasks heißt nicht, dass der Gast den Zielzustand erreicht hat [?]. Deshalb zusätzlich den Gaststatus abfragen.
- Timeouts: QEMU-Start wartet standardmäßig `max(30, RAM in GiB)` s, LXC-Shutdown 60 s [D]. Der 30-s-Poll des Altcodes [A `proxmox.py:380`] ist zu kurz. Aktionen laufen deshalb als Hintergrundjob mit Fortschritt (bis 5 min).
- Reservierte Snapshot-Namen: `current`, `pending` (QEMU) bzw. `current`, `vzdump` (LXC). LXC kennt kein `vmstate` [D].
- Storage mit `shared=1` erscheint in `/cluster/resources` einmal pro Knoten. Für `StoragePool` nach Storage-ID deduplizieren.
- Keine CPU-Temperatur über die API [A `README.md:249-252`], im neuen Plugin weglassen.
- Docker-Container innerhalb von LXC (z. B. CT 104 „Portainer + Immich“ [A `proxmox.py:19`]) sieht PVE nicht. Dafür ist das eigene Docker-Plugin zuständig.
- PBS läuft hier als Gast VMID 201 [A `proxmox.py:23`]: Fällt der PVE-Host aus, sind auch die Backups weg. Das UI verknüpft den Gast mit dem `proxmox-backup-server`-Exemplar.
- `externalId`: Host `node/<name>`, Guest `<type>/<vmid>` (VMIDs sind clusterweit eindeutig [D nextid]), StoragePool `storage/<id>` (shared) bzw. `storage/<node>/<id>`. Jeweils mit Präfix `<clusterName>`.

## Wissen aus dem Altcode
| Erkenntnis | Fundstelle | Konsequenz für v2 |
|---|---|---|
| Header `PVEAPIToken=id=secret` funktioniert produktiv | [A `clients/proxmox.py:27-30`] | übernehmen |
| `verify=False` als Default | [A `config.py:60`, `BACKEND_AUDIT.md:118`] | ersetzen durch Fingerprint-Pinning |
| Nur ein Knoten (`/nodes/{PROXMOX_NODE}/…`) | [A `proxmox.py:89,217-218,267`] | `/cluster/resources` + Failover |
| VM-RAM über `status/current`, auf `maxmem` begrenzt | [A `proxmox.py:180-211`, Tests `test_proxmox.py:138-212`] | unter PVE 9 `mem`/`memhost` nutzen, Begrenzung behalten |
| LXC-IP nur aus statischer `config` (`ip=`), DHCP fehlt | [A `proxmox.py:155-163`] | `GET …/lxc/{vmid}/interfaces` [D] |
| Host-Journal je VMID braucht `Sys.Syslog`, mit PVEAuditor kommt still `[]` zurück | [A `proxmox.py:311-345`, `system.py:184-203`] vs. [D Nodes.pm] | entfällt oder wird optional mit eigener Rolle |
| Historie selbst gesampelt („PVE API doesn't expose its own history“) | [A `system.py:145-146`, `main.py:219-270`] | falsch, `rrddata` bzw. `/cluster/metrics/export` nutzen [D] |
| Reboot: UPID abfragen, `exitstatus=OK`. Ohne UPID gilt Erfolg | [A `proxmox.py:375-444`, Tests `:326-388`] | Polling übernehmen, Fallback „ohne UPID = Erfolg“ streichen |
| UPID mit `quote(safe="")` gegen Pfad-Traversal | [A `proxmox.py:293,393`, Tests `:390-421`] | übernehmen |
| `restart_guest` behandelt jeden Typ außer `lxc`/`ct` als `qemu`. Nur der Router prüft (`?type=docker` → 400) | [A `proxmox.py:423`, `test_rbac_writes.py:97-100`] | Typ aus `/cluster/resources` ableiten, nicht vom Client übernehmen. Zu „docker“ gibt es in `proxmox.py` keinen Treffer, nur im Test. |
| Feste VMID→Dienst-Labels | [A `proxmox.py:14-24`, `HARDCODED_DATA_AUDIT.md:44-52`] | PVE-`tags`/Notizen oder lokale Labels, keine Hardcodes |
| SETUP.md: ACL nur für den Benutzer, obwohl privsep an ist. „VM.PowerMgmt auf /vms/<vmid>“ ohne Rolle | [A `docs/SETUP.md:45-58`] | falsch: Das Token hätte keine Rechte. Für Benutzer **und** Token setzen und eine Rolle anlegen [D] |
| Beispiel-Token `root@pam!admin-dashboard` | [A `config.py:58`] | im Onboarding ausdrücklich davon abraten |
| Restart nur für operator+ (RBAC-Test) | [A `system.py:87-112`, `test_rbac_writes.py:62-95`] | Rollenmodell übernehmen, `stop` nur für admin |

## Testbarkeit (Vertragstests)
- Kein offizielles OpenAPI. Es gibt aber `pve-docs/api-viewer/apidata.js` (ca. 4,3 MB, JS-Konstante `apiSchema` mit Pfaden, Methoden, Parametern, `returns` und `permissions`) [D]. Eine versionierte Kopie im Repo erlaubt offline in CI: Zod-Schemas generieren oder abgleichen und prüfen, ob jeder genutzte Endpunkt und jedes Privileg existiert.
- Bestehende Altfixtures sind von Hand geschriebene `respx`-Payloads, keine Aufzeichnungen [A `test_proxmox.py` (17 Tests), `test_rbac_writes.py`]. Sie taugen als Regressionsfälle (RAM-Begrenzung, UPID-Encoding, Task-Fehler).
- Neue Fixtures aufzeichnen: im LXC mit dem echten Token (`curl` gegen die eigenen Endpunkte) oder auf dem Host `pvesh get /cluster/resources --output-format json`. Hostnamen, IPs, MACs und Token-IDs schwärzen. Mindest-Set: Einzelknoten, 3-Knoten-Cluster mit einem Offline-Knoten, ohne Quorum, Token ohne ACL (401/403), HA-Gast, Task-Lebenszyklus (running → OK / Fehler).

## Aufwand & Empfehlung
- Aufwand **L**: Failover über mehrere Endpunkte mit Pinning je Knoten, Rechtediagnose über `/access/permissions`, Offline-Knoten-Logik, fünf Aktionen mit asynchronem Task-Tracking und HA-Sonderfällen, RRD-Charts, sieben Widgets.
- Abhängigkeiten: SDK (Actions + Hintergrundjobs + Audit), TLS-Pinning-Baustein (gemeinsam mit PBS), Metric-Speicher. Querverweis auf `proxmox-backup-server` (Gast ↔ Backup-Gruppe).
- Empfohlene Welle: **1** (vorhandene Integration, Kern des Dashboards). Zuerst nur lesend, Aktionen danach im selben Release.

## Offene Punkte
- Ist es heute ein Einzelknoten (Altcode: `rxf-sys`) oder ist ein Cluster geplant? Das Design deckt beides ab.
- Snapshot-Aktion wirklich gewünscht? `VM.Snapshot` erlaubt dem Token auch Löschen und Rollback.
- `stop` (hart) nur für admin oder auch für operator mit erneuter Anmeldung?
- Host-Journal-Funktion beibehalten (braucht eigene Rolle mit `Sys.Syslog`)?
- ACL-Variante A oder B? Eigenes ACME-Zertifikat auf PVE (dann `tlsMode=system`)?
- Seit welcher Version gibt es `/cluster/metrics/export`? Falls ab 8.x: als primäre Metrikquelle nutzen [?].

## Quellen
1. https://github.com/proxmox/pve-access-control/blob/master/src/PVE/AccessControl.pm – Privileggruppen, Aufbau von PVEAuditor/PVEVMUser/PVEVMAdmin, privsep-Flag
2. https://github.com/proxmox/pve-access-control/blob/master/src/PVE/RPCEnvironment.pm – Schnittmenge Token/Benutzer, Pool-ACLs, `check_vm_perm`
3. https://github.com/proxmox/pve-access-control/blob/master/src/PVE/API2/AccessControl.pm – `GET /access/permissions` (eigene Rechte ohne Zusatzprivileg)
4. https://github.com/proxmox/pve-docs/blob/master/pveum.adoc – Token-Header, privsep, `pveum`-Befehle, Pfade, Propagation
5. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Cluster.pm – `/cluster/resources` (Felder, lokal), `/cluster/tasks`, `/cluster/status`, `nextid`
6. https://github.com/proxmox/pve-manager/blob/master/PVE/API2Tools.pm – Statuswerte online/offline/unknown, keine Alterungsprüfung
7. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Nodes.pm – Knotenstatus, `rrddata`, `journal`/`syslog` (Sys.Syslog), `proxyto`
8. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Tasks.pm – Task-Liste, Filter, Status, Log, Rechte
9. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Cluster/MetricServer.pm – `/cluster/metrics/export`
10. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Cluster/BackupInfo.pm – `not-backed-up`
11. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Backup.pm – `/cluster/backup` (Sys.Audit `/`)
12. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/APT.pm – `apt/update` braucht Sys.Modify
13. https://github.com/proxmox/pve-manager/blob/master/PVE/API2/Certificates.pm – `certificates/info`, Cluster-CA-Dateien
14. https://github.com/proxmox/pve-ha-manager/blob/master/src/PVE/API2/HA/Status.pm – HA-Status, Sys.Audit `/`
15. https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu.pm – VM-Liste, Power-Endpunkte, Snapshot (VM.Snapshot, Rollback mit `any`), `rrddata`
16. https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu/Agent.pm – Agent-Befehle → `VM.GuestAgent.Audit`
17. https://github.com/proxmox/pve-container/blob/master/src/PVE/API2/LXC.pm, …/LXC/Status.pm, …/LXC/Snapshot.pm – LXC-Liste, `interfaces`, Power, Snapshot ohne vmstate
18. https://github.com/proxmox/pve-storage/blob/master/src/PVE/API2/Storage/Status.pm, …/API2/Disks.pm – Storage-Liste/RRD, `disks/list` (SMART per Default)
19. https://github.com/proxmox/pve-docs/blob/master/api-viewer/apidata.js – maschinenlesbares API-Schema
20. https://lists.proxmox.com/pipermail/pve-devel/2025-July/073215.html – `VM.Monitor` in PVE 9 entfernt [S]
21. https://lists.proxmox.com/pipermail/pve-devel/2025-July/073642.html – `memhost` / geänderte `mem`-Semantik [S]
22. https://lists.proxmox.com/pipermail/pve-devel/2021-April/047819.html – kein CSRF-Token für API-Tokens [S]
23. https://lists.proxmox.com/pipermail/pve-devel/2013-June/007994.html – `pvestatd` 10-s-Takt [S]
24. https://forum.proxmox.com/threads/http-api-error-596.84110/ – 595/596 bei Proxy-Fehlern zwischen Knoten [S]
25. https://pve.proxmox.com/wiki/FAQ – Support-Zeiträume, PVE 8 EOL 08/2026 [S]
26. https://forum.proxmox.com/threads/proxmox-virtual-environment-9-0-released.169257/ – PVE 9.0 erschienen am 05.08.2025 [S]
