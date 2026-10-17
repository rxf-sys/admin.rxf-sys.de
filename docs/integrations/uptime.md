# Uptime & Probes (`uptime`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick

- Kategorie: **Monitoring**
- Zweck: eingebautes Plugin, das eigene Checks ausführt: HTTP(S), TCP, ICMP-Ping, DNS und TLS-Ablauf. Es speichert Antwortzeiten und Status als Zeitreihe und ersetzt `backend/app/clients/probes.py` samt Probe-Historie.
- Keine Hersteller-API. Grundlage ist die Node-22-Laufzeit. Alle Node-Angaben wurden gegen `doc/api/*.md` im Branch `v22.x` von `github.com/nodejs/node` geprüft [D]. Für HTTP kommt undici dazu (`github.com/nodejs/undici`, Branch `main`) [D].
- Laufumgebung v2: Backend-Container als **Non-Root**, **read-only rootfs**, Docker in einem **unprivilegierten Proxmox-LXC**. Die alte CT 110 ist so angelegt (`--unprivileged 1`, `nesting=1`) [A `infrastructure/setup-lxc.sh:58-59`], für den v2-LXC wird dasselbe angenommen [?]. Das ist für ICMP entscheidend (siehe „Minimale Rechte“).

## Verbindung & Auth

- Keine Plugin-Anmeldung. Pro Check optional: HTTP-Header (z. B. `Authorization: Bearer …` für Health-Endpunkte) als Secret, write-only.
- **TLS je Check** (nie global abschaltbar):

  | Modus | Verhalten | Grundlage |
  |---|---|---|
  | `verify` (Standard) | normale Kettenprüfung + Hostname | `rejectUnauthorized` Standard `true` [D] |
  | `pin` (TOFU) | Beim ersten Kontakt wird `fingerprint256` des Leaf-Zertifikats gespeichert. Danach wird verglichen und bei Abweichung abgebrochen. | undici-`buildConnector` mit eigenem `connect`, Vorbild ist das Fingerprint-Beispiel der undici-Doku [D] |
  | `ca` | eigene CA (PEM) für interne PKI | `ca` über `tls.createSecureContext` [D] |

- Der Altcode schaltet für **alle** internen Probes die TLS-Prüfung ab (`verify=False`) [A `backend/app/clients/probes.py:94-96`]. In v2 wird das durch `pin` ersetzt.
- SSRF: Das Plugin darf beliebige Ziele prüfen, deshalb dürfen nur Admins Checks anlegen. Zusätzlich gilt eine Sperrliste: Link-Local/Metadata `169.254.0.0/16` und die eigene Container-Loopback, außer bei ausdrücklicher Freigabe. Umgesetzt wird sie über `net.BlockList` [D] in einem eigenen `lookup`/Connector. Redirects werden standardmäßig nicht verfolgt [A `probes.py:76`].
- Entwurf `configSchema` (Plugin-Ebene; Checks sind Entitäten mit eigenem Schema, s. u.):

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `defaultIntervalS` | int ≥ 10 | nein | nein | Standardintervall, Altcode 30 s [A `config.py:124`] |
| `defaultTimeoutMs` | int | nein | nein | Standard-Timeout, Altcode 4.000 ms [A `config.py:116`] |
| `maxConcurrency` | int | nein | nein | parallele Checks gesamt (Standard 10) |
| `icmpMode` | enum `auto`/`exec`/`off` | nein | nein | `auto` prüft beim Start, ob `ping` funktioniert (s. u.) |
| `slowThresholdMs` | int | nein | nein | ab hier `warn`, Altcode 800 ms [A `probes.py:108`, `122`] |
| `downAfterS` | int | nein | nein | Anti-Flap vor Alarm, Altcode 180 s [A `config.py:158`] |
| `allowBlockedTargets` | bool | nein | nein | Freigabe für Ziele aus der SSRF-Sperrliste |

Check-Schema (Entität `uptime.check`): `name`, `type` (`http`/`tcp`/`icmp`/`dns`/`tls`), `target`, `port`, `intervalS`, `timeoutMs`, `serviceRef` (Verknüpfung zu `Service`/`Host` anderer Plugins), `group` + `role` (`internal`/`external`, siehe Altcode-Semantik). Typspezifische Felder:

- **http**: `method` (`GET` Standard), `expectedStatus` (z. B. `200-399,401,405`), `keyword`, `followRedirects`, `tlsMode`, `pinnedSha256`.
- **dns**: `server`, `recordType`, `expected`.
- **icmp**: `count`.
- **tls**: `servername`, `warnDays`/`critDays`.

## Minimale Rechte

### Nur lesen

Es gibt keine Tokens. Nötig sind nur Netzwerkzugang zu den Zielen und für ICMP eine der folgenden Varianten:

| Variante | Voraussetzung | In v2 (non-root, read-only, Docker im unpriv. LXC) | Trade-offs | Quelle |
|---|---|---|---|---|
| **A** Unprivilegierte ICMP-Echo-Sockets (`SOCK_DGRAM`/`IPPROTO_ICMP`) | GID des Prozesses in `net.ipv4.ping_group_range` des Container-Netns. Kernel-Default `"1 0"` heißt: niemand. | Docker setzt `"0 2147483647"` automatisch, aber **nicht**, wenn der Daemon in einem User-Namespace läuft (`userns.RunningInUserNS()`). Bei Docker in einem unprivilegierten LXC trifft genau das zu, also ist **manuell** über Compose `sysctls` zu setzen. Der Wert muss im LXC-ID-Mapping liegen: `"0 2147483647"` scheitert auf Proxmox mit „invalid argument“ [S], ein enger Bereich wie `"<gid> <gid>"` ist auf CT zu testen [?]. | keine Capability nötig, nur Echo, kein Raw-Paketbau; sicherste Variante | [D] Kernel `ip-sysctl.rst`; [D] moby `daemon/oci_linux.go`; [A `setup-lxc.sh:59`]; [S] Docker-Forum |
| **B** `CAP_NET_RAW` (Raw-Socket) | Capability im effektiven Set | Steht in Dockers Default-Set [D], wirkt aber nur für root. Ein Non-Root-Prozess bräuchte File-Caps auf `ping`, die bei `no-new-privileges` ignoriert werden: „file capabilities will not add to the permitted set“ [D]. Praktisch hieße das root im Container oder ein Sidecar. | Raw-Sockets erlauben beliebige Pakete (Spoofing), widerspricht der Härtung | [D] moby `caps/defaults.go`; [D] Kernel `no_new_privs.rst` |
| **C** `ping` aufrufen (`iputils-ping` im Image) per `child_process.execFile` | A oder B. iputils versucht erst `SOCK_DGRAM` und fällt bei `EACCES`/`EAFNOSUPPORT`/`EPROTONOSUPPORT` auf `SOCK_RAW` zurück. | funktioniert, sobald A greift | kein Shell-Aufruf (`execFile`), `timeout`/`killSignal`/`signal` verfügbar [D]. Kosten: ein Prozess je Ping. Ausgabe ist per gettext lokalisiert, deshalb `LC_ALL=C` setzen und parsen. | [D] iputils `ping/ping.c`, `ping_common.c`; [D] `child_process.md` |
| **D** Native Addon (Raw-Socket-npm) | B | wie B | Build-Toolchain, ABI-Bindung an Node-Version, braucht trotzdem `CAP_NET_RAW` | [?] |
| **E** TCP-„Ping“ (Connect auf 22/80/443) | nichts | funktioniert immer | misst Handshake-RTT statt ICMP und braucht einen offenen Port | [D] `net.md` |

Node selbst kann kein ICMP: `dgram` kennt nur `'udp4'`/`'udp6'` [D]. **Empfehlung:** Variante **C + A**. Compose-Snippet (Wert auf CT verifizieren [?]):

```yaml
services:
  backend:
    user: "1000:1000"
    read_only: true
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    sysctls:
      net.ipv4.ping_group_range: "1000 1000"
```

`test()` führt beim Start einen Ping gegen `127.0.0.1` aus. Schlägt er mit „Operation not permitted“ fehl, setzt das Plugin `icmp` auf `unavailable`: ICMP-Checks melden `unknown` statt `crit`, und das UI schlägt TCP-Checks vor.

### Zusätzlich für Aktionen

Keine externen Rechte. Aktionen wirken nur im Plugin (siehe Matrix). Check anlegen/ändern/löschen ist Konfiguration und bleibt admin-only wie im Altcode [A `backend/app/routers/services.py:78-148`].

### Anleitung: Check anlegen (für den Onboarding-Assistenten)

1. **Uptime › Neuer Check** → Typ wählen. [Screenshot: Typauswahl mit fünf Kacheln]
2. Ziel eingeben. Vorschläge kommen aus anderen Plugins: Cloudflare-Ingress-Hostnames, Proxmox-Gast-IPs. [Screenshot: Zielfeld mit Vorschlagsliste]
3. „Check testen“: einmalige Ausführung mit Phasen-Wasserfall (DNS/TCP/TLS/TTFB) und verständlichem Fehlercode.
4. Bei selbstsigniertem Zertifikat zeigt der Assistent Fingerprint (SHA-256), Aussteller, SAN und Ablauf. Mit „Diesem Zertifikat vertrauen“ wird gepinnt. [Screenshot: TOFU-Dialog]
5. Optional internes und externes Paar anlegen (z. B. `http://192.168.2.203` + `https://vault.rxf-sys.de`) und einem Service zuordnen.
6. Nur für ICMP: Steht im Plugin-Status „ICMP nicht verfügbar“, zeigt der Assistent das Compose-Snippet oben. Doku-Links: https://github.com/torvalds/linux/blob/master/Documentation/networking/ip-sysctl.rst (`ping_group_range`) und https://github.com/moby/moby/blob/master/daemon/oci_linux.go.

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| HTTP-Status, Keyword, Gesamtzeit | `undici.request()` über eigenen `Agent` mit `connect`-Funktion. `headersTimeout`/`bodyTimeout` setzen (Default je 300 s, zu lang). | `Endpoint` + `Metric` | 30 s / 60 s | [D] undici `Client.md`; [A `probes.py:71-83`] |
| HTTP-Phasen: DNS, TCP, TLS, TTFB | DNS über eigenen `lookup` messen. TCP/TLS: Zeit von Connector-Aufruf bis Callback bzw. Socket-Events `connect`/`secureConnect`. TTFB: Auflösen von `request()` (Header da). Messbar nur bei **neuer** Verbindung, weil Connections gepoolt werden. | `Metric` | wie oben | [D] undici `Connector.md`, `DiagnosticsChannel.md`; [D] `tls.md` |
| TCP-Erreichbarkeit + Connect-Zeit | `net.createConnection({host, port, timeout})`. Bei `'timeout'` selbst `destroy()`, weil `setTimeout` nicht schließt. `autoSelectFamily` Default `true`, Versuchs-Timeout 250 ms. | `Endpoint` + `Metric` | 30 s / 120 s | [D] `net.md` |
| ICMP-RTT, Paketverlust | `execFile('ping', ['-n','-c',N,'-W',s,'--',ip], {timeout, env:{LC_ALL:'C'}})` | `Host` + `Metric` | 60 s / 300 s | [D] `child_process.md`, iputils; Flags [?] |
| DNS-Antwort + Antwortzeit | `new dns.promises.Resolver({timeout, tries})` + `setServers(['192.168.2.1'])` → `resolve4`/`resolve6`/`resolveCname`/`resolveMx`/`resolveTxt`. TTL über `{ttl:true}`. | `Endpoint` (kind `dns`) + `Metric` | 60 s / 300 s | [D] `dns.md` |
| TLS: Ablauf, Aussteller, SAN, Fingerprint | `tls.connect({host, port, servername})` → `getPeerX509Certificate()` (`validToDate` ab v22.10.0) bzw. `getPeerCertificate()` (`valid_to`, `fingerprint256`, `subjectaltname`, `issuer`) | `Certificate` | 6 h / 24 h, zusätzlich passiv bei jedem HTTPS-Check | [D] `tls.md`, `crypto.md` |
| Uptime %, p95, Verlauf | Core-Zeitreihe (`Metric`), Rollups | `Metric` | – | [A `backend/app/storage.py:176-234`] |
| Incidents (Zustandswechsel) | Statusübergänge → Alert-Engine | `Alert` | – | [A `storage.py:242-300`] |

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| `check.runNow` – sofort prüfen | intern (Scheduler-Trigger, dedupliziert) | low | operator | – | [A `probes.py:86`, `state.service_snapshot.request_refresh`] |
| `check.pause` / `check.resume` – Wartungsfenster | intern | low | operator | – | [?] neu |
| `check.retrustCert` – neuen Fingerprint pinnen (zeigt alten/neuen Fingerprint im Audit) | intern | medium (Sicherheitsentscheidung) | admin | – | [?] neu |

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| Status-Zähler | n ok / warn / crit / unknown | S |
| Service-Grid | Kachel je Service mit INT/EXT-Pill, ms, Sparkline (wie `ServiceGrid`) | M, L |
| Antwortzeit | Zeitreihe ms + p95 eines Checks oder einer Gruppe | M, L |
| Uptime-Balken | 30/90 Tage als Tagesbalken | L, XL |
| Zertifikatsablauf | nächste ablaufende Zertifikate (Origin, nicht Edge) | S, M |

### Seiten (Vorschlag)

- **Uptime › Übersicht**: Grid/Tabelle aller Checks, Filter nach Typ/Status/Tag.
- **Check-Detail**: Zeitreihe, Phasen-Wasserfall des letzten Laufs, Incident-Liste, TLS-Details.
- **Zertifikate**: alle per TLS gesehenen Zertifikate. Die Edge-Zertifikate liefert das Plugin `cloudflare`.
- **Diagnose**: ICMP-Fähigkeit, DNS-Resolver, Sperrliste, Scheduler-Auslastung.

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Check down | ≥ `downAfterS` (180 s) durchgehend fehlgeschlagen [A `notify.py:149-185`] | crit |
| Teilausfall | Paar: intern ok, extern fehlgeschlagen („Cloudflare-Tunnel oder DNS-Konfiguration prüfen“) oder umgekehrt [A `probes.py:104-115`] | warn |
| Langsam | Antwortzeit > `slowThresholdMs` (800 ms) über 3 Läufe | warn |
| TLS läuft ab | ≤ 14 Tage bzw. ≤ 7 Tage [A `config.py:160`, `notify.py:224-240`] | warn / crit |
| Fingerprint geändert | `pin`-Modus, Fingerprint ≠ gepinnt | crit |
| DNS-Abweichung | Antwort ≠ `expected` | warn |
| Paketverlust | > 20 % bzw. 100 % | warn / crit |
| Wieder erreichbar | Rückkehr zu ok nach Alarm (Altcode: „Service erholt“) | info |

## Rate-Limits & Last

- Keine Herstellerlimits. Es gelten Selbstbeschränkungen:
  - `maxConcurrency`
  - Jitter (± 10 % Intervall)
  - mindestens 10 s je Ziel
  - Deduplizierung identischer Ziele (z. B. TLS-Check und HTTPS-Check desselben Hosts teilen den Handshake)
- `dns.lookup()` (Default für HTTP/TCP) läuft als `getaddrinfo` im libuv-Threadpool [D]. Bei vielen gleichzeitigen Checks wird der Pool zum Engpass, dann `UV_THREADPOOL_SIZE` anheben. `dns.resolve*()` nutzt den Threadpool nicht [D].
- Datenmenge Altcode: 8 Services × 2.880 Läufe/Tag = ca. 23.000 Zeilen/Tag, bei 7 Tagen ca. 161.000 Zeilen [A `config.py:124`, `145`]. Mit Phasen-Metriken je Check entstehen in v2 4–5 Serien. Daher Rollups (z. B. Rohdaten 14 Tage, 5-min-Aggregate 90 Tage, Stundenwerte 1 Jahr) [?] als Core-Entscheidung.
- Intervall aktiv/Hintergrund: Uptime ist Überwachung. Der Hintergrund darf nicht beliebig verlangsamen, Alarme brauchen höchstens 60 s.

## Verbindungstest & Fehlercodes

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `DNS_NOT_FOUND` | `ENOTFOUND` [D] | „Hostname {host} lässt sich nicht auflösen.“ |
| `DNS_TIMEOUT` | Resolver `ETIMEOUT` / `ECONNREFUSED` [D] | „DNS-Server {server} antwortet nicht.“ |
| `DNS_MISMATCH` | Antwort ≠ `expected` | „DNS liefert {ist} statt {soll}.“ |
| `TCP_REFUSED` | `ECONNREFUSED` [D] | „Port {port} geschlossen – Dienst läuft nicht oder Firewall blockt.“ |
| `TCP_TIMEOUT` | eigener Timeout, `ETIMEDOUT` [D], `UND_ERR_CONNECT_TIMEOUT` [D] | „Host nicht erreichbar (keine Antwort innerhalb {t} ms).“ |
| `NET_UNREACHABLE` | `EHOSTUNREACH`/`ENETUNREACH` [?] | „Kein Netzweg zum Host – Routing/VLAN prüfen.“ |
| `TLS_EXPIRED` | `CERT_HAS_EXPIRED` [D] | „Zertifikat ist am {datum} abgelaufen.“ |
| `TLS_NOT_YET_VALID` | `CERT_NOT_YET_VALID` [D] | „Zertifikat ist noch nicht gültig – Uhrzeit prüfen.“ |
| `TLS_SELF_SIGNED` | `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN` [D] | „Selbstsigniertes Zertifikat – Fingerprint prüfen und vertrauen?“ |
| `TLS_UNKNOWN_CA` | `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` [D] | „Zertifikat unbekannt – Aussteller nicht vertrauenswürdig.“ |
| `TLS_HOSTNAME` | `ERR_TLS_CERT_ALTNAME_INVALID` [D] | „Zertifikat gilt nicht für {host}.“ |
| `TLS_PIN_MISMATCH` | `fingerprint256` ≠ gepinnt | „Zertifikat hat sich geändert – möglicher Angriff oder Zertifikatstausch.“ |
| `HTTP_STATUS` | Status ∉ `expectedStatus` | „Dienst antwortet mit HTTP {code}.“ |
| `HTTP_TIMEOUT` | `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` [D] | „Verbindung steht, aber keine Antwort innerhalb {t} ms.“ |
| `HTTP_KEYWORD` | Keyword fehlt im Body | „Antwort enthält „{keyword}“ nicht.“ |
| `ICMP_UNAVAILABLE` | `ping` meldet „Operation not permitted“ bzw. `EACCES` [D iputils] | „Ping im Container nicht erlaubt – `ping_group_range` setzen (Anleitung).“ |
| `ICMP_NO_REPLY` | 100 % Verlust | „Host antwortet nicht auf Ping (ICMP evtl. gefiltert).“ |
| `TARGET_BLOCKED` | Ziel in SSRF-Sperrliste | „Ziel {ip} ist gesperrt (Link-Local/Metadata).“ |

## Eigenheiten & Stolperfallen

- **„Up“-Definition im Altcode**: Jeder Status < 500 gilt als erreichbar, also auch 404 [A `probes.py:79`]. Der Kommentar nennt nur 2xx/3xx/401/405. Der v2-Default ist `200-399,401,403,405`, für migrierte Checks wird `<500` übernommen [?].
- **GET statt HEAD**, weil viele Self-Hosted-Apps auf HEAD 405 liefern [A `probes.py:75-76`].
- **SNI**: `servername` muss ein Hostname sein, keine IP [D]. Für IP-Ziele mit Zertifikat bleibt nur `pin` oder `servername` explizit setzen.
- `getPeerCertificate()` liefert `{}` ohne Zertifikat und `null` bei zerstörtem Socket [D]. `valid_to` ist ein String wie `'Nov 20 23:59:59 2019 GMT'` [D]. Darum `x509.validToDate` nutzen (ab v22.10.0) [D] und `engines: >=22.10` setzen.
- `'secureConnect'` feuert auch bei nicht autorisiertem Zertifikat [D]. Bei `rejectUnauthorized:false` immer `authorized`/`authorizationError` oder den Pin prüfen.
- **undici-Versionen**: Die gebündelte undici in Node 22 und das npm-Paket `undici` (main) haben unterschiedliche Defaults, z. B. `allowH2` in main `true` [D] und in älteren Versionen abweichend [?]. Das npm-Paket mit fester Version pinnen. `autoSelectFamily` ist im undici-Client Default `false`, in `net` `true` [D]. IPv4/IPv6-Verhalten deshalb explizit setzen.
- **Pooling verfälscht Messungen**: Bei Keep-Alive fehlen DNS/TCP/TLS-Phasen. Pro Check eigener `Agent` mit `keepAliveTimeout` kurz oder Verbindung schließen; Phasen nur bei Neuverbindung als „gemessen“ markieren [?].
- **DNS**: `resolver.setServers()` darf nicht während laufender Queries aufgerufen werden [D], deshalb ein `Resolver` je Server. `resolveAny` ist unzuverlässig (RFC 8482) [D]. `dns.lookup` beachtet `/etc/hosts` und Dockers eingebauten DNS, `Resolver` mit `setServers` umgeht beides [D].
- **`execFile` + Option-Injection**: Ziel streng validieren (IP oder Hostname-Regex), nie mit `-` beginnen lassen, `--` vor das Ziel setzen [?].
- **Wochenreport erzeugt Zusatz-Samples**: `build_report` ruft `probe_all` auf und schreibt Historie [A `backend/app/weekly_report.py:59`]. CRUD-Refresh und Cold-Start tun dasselbe [A `routers/services.py:71-74`]. Die Abtastung im Altcode ist also **unregelmäßig**.
- **„30-Tage-Uptime“ im Altcode** rechnet über 720 h [A `routers/services.py:50`], die Aufbewahrung beträgt aber nur 7 Tage [A `config.py:145`]. Der Wert ist faktisch eine 7-Tage-Uptime.
- `probes.py` hat 32 % Testabdeckung [A `BACKEND_AUDIT.md:104`]. Die Statuslogik ist ungetestet.

## Wissen aus dem Altcode

**Datei:** `STORAGE_DB_PATH`, Default `/data/rxf-admin.db` [A `config.py:142`; `docs/SETUP.md` §8]. `CLAUDE.md` nennt `/data/probes.db`, das ist veraltet. Dieselbe Datei enthält Konten, Sessions, TOTP-Secrets und API-Tokens. Der Import öffnet sie deshalb **read-only** (`?mode=ro`) und liest nur die drei Tabellen unten.

**Schema** (wörtlich aus [A `backend/app/storage.py:37-55`] und [A `backend/app/registry.py:30-39`]):

```sql
CREATE TABLE IF NOT EXISTS probe_history (
    ts         INTEGER NOT NULL,
    service_id TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    response_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_history_service_ts ON probe_history (service_id, ts);
CREATE INDEX IF NOT EXISTS idx_probe_history_ts ON probe_history (ts);

CREATE TABLE IF NOT EXISTS service_incidents (
    service_id  TEXT    NOT NULL,
    started_ts  INTEGER NOT NULL,
    ended_ts    INTEGER,
    worst_status TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_incidents_service_started
    ON service_incidents (service_id, started_ts DESC);

CREATE TABLE IF NOT EXISTS custom_services (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'cloud',
    descr TEXT NOT NULL DEFAULT '', internal_url TEXT NOT NULL, ext_url TEXT,
    created_by TEXT, created_at INTEGER NOT NULL
);
```

| Spalte / Aspekt | Bedeutung | Quelle |
|---|---|---|
| `ts` | Unix-**Sekunden**, **ein** Zeitstempel je Batch (nach Abschluss aller Probes) | [A `storage.py:133-134`] |
| `service_id` | `custom_services.id`: Built-ins wie `vault`, `cloud` …, eigene als `custom-<8 hex>`. Kein FK, gelöschte Services hinterlassen Waisen bis zur Retention. | [A `registry.py:200`, `probes.py:17-26`] |
| `status` | nur `ok`/`warn`/`err` (`idle` existiert im Typ, wird nie geschrieben) | [A `models.py:7`, `probes.py:99-125`] |
| Statuslogik | Mit `ext_url`: beide down → `err`, einer down → `warn`, > 800 ms → `warn`, sonst `ok`. Nur intern: down → `err`, > 800 ms → `warn`. | [A `probes.py:101-125`] |
| `response_ms` | **eine** Zahl: interne ms, wenn intern ok, sonst externe ms. Bei Fehler die Zeit bis zum Fehler/Timeout. | [A `probes.py:73-83`, `103`] |
| Nicht gespeichert | HTTP-Codes, Trennung intern/extern, Fehlerursache, Notiz | [A `probes.py:126-143`, `149`] |
| Primärschlüssel | keiner (nur implizite `rowid`) | [A `storage.py:37-42`] |
| Uptime | Anteil `status='ok'` an **Samples**. `warn` zählt als „nicht up“, ohne Zeitgewichtung. | [A `storage.py:176-202`] |
| p95 | Nearest-Rank über sortierte `response_ms` | [A `storage.py:205-234`] |
| Incidents | Öffnen bei `warn`/`err` ohne offenen Incident, Schließen (`ended_ts`) bei `ok`, Eskalation `warn`→`err` in `worst_status` | [A `storage.py:242-300`] |
| Takt | `PROBE_INTERVAL_S` 30 s plus Zusatzläufe (s. o.), Timeout 4 s | [A `config.py:116`, `124`; `main.py:196-216`] |
| **Retention** | `HISTORY_RETENTION_DAYS` = **7**. Cleanup alle `HISTORY_CLEANUP_INTERVAL_S` = 3.600 s, erster Lauf erst nach einer Stunde. Löscht `probe_history` mit `ts < now-7d` und geschlossene Incidents mit `ended_ts < now-7d`. Offene Incidents bleiben. | [A `config.py:145-147`; `storage.py:520-549`; `main.py:181-187`] |

**Migrationsvorschlag** (Ziel: Core-Zeitreihe):

1. Je `custom_services`-Zeile entsteht ein `Service` (`externalId` = alte `id`) mit HTTP-Check für `internal_url` (`role=internal`). Bei gesetzter `ext_url` kommt ein zweiter Check dazu (`role=external`), beide in einer `group`.
2. `probe_history` geht in die **Gruppen**-Serien `uptime.status` und `uptime.response_ms`, nicht in die Einzel-Checks, weil intern und extern im Altcode verschmolzen sind. Markierung `source=legacy`. Zeitstempel × 1000, falls v2 Millisekunden nutzt.
3. Statusmapping: `ok`→`ok`, `warn`→`warn`, `err`→`crit`.
4. `service_incidents` werden zu Alert-Historie. Offene Incidents werden beim Cutover geschlossen und markiert. Waisen ohne Service werden als „archiviert“ importiert oder verworfen (Owner-Entscheid).
5. **Sofort umsetzbar:** Wegen 7 Tagen Retention landet nur die letzte Woche in v2. Für mehr Historie jetzt in v1 `HISTORY_RETENTION_DAYS` erhöhen, z. B. 90. Das ist eine reine ENV-Änderung.

**GeoIP im Altcode:** `clients/geoip.py` ruft `https://ipapi.co/{ip}/json/` auf (Free-Tier, laut Kommentar 1.000 Req/Tag). Das Modul hat **einen** Zweck: den ISP-Namen für das Netzwerk-Panel ergänzen, wenn weder die lokale UniFi-API noch die Site-Manager-API ihn liefert [A `geoip.py:1-13`, `24`; `routers/network.py:42-50`]. Es sendet die WAN-IP an einen Drittanbieter, ist standardmäßig an (`GEOIP_ENABLED=true`) und wird 6 h gecacht [A `config.py:134-137`]. Mit Probes hat es nichts zu tun, deshalb **gehört es nicht ins Uptime-Plugin**. Empfehlung: Es wird als optionale, standardmäßig **aus**geschaltete Anreicherung in das Router-/Netzwerk-Plugin (UniFi/FRITZ!Box) verschoben oder gestrichen. Die WAN-IP liefert das Cloudflare-Plugin ohne Drittanbieter über `origin_ip`.

## Testbarkeit (Vertragstests)

- Kein Hersteller-Schema. Tests laufen gegen lokale Fake-Ziele, die im Test erzeugt werden:
  - HTTP- und HTTPS-Server mit zur Laufzeit erzeugtem selbstsigniertem Zertifikat (TOFU, Pin-Mismatch, Ablauf, falscher SAN)
  - `net`-Server (refused/timeout)
  - DNS-Stub über `dgram` `udp4` auf zufälligem Port, angesprochen per `setServers(['127.0.0.1:<port>'])` [D]
- ICMP in CI nie real. Den Parser mit einmalig auf CT aufgenommenen `ping`-Ausgaben (`LC_ALL=C`) testen und `execFile` mocken.
- Altlasten: `backend/tests/test_storage.py` (Roundtrip, Uptime nur `ok`, p95 Nearest-Rank, Incident öffnen/schließen/eskalieren, Cleanup inkl. offener Incidents), `test_routers_services.py` (CRUD, Snapshot statt Inline-Probe), `test_geoip.py` (ASN-Strip, Fehlerpfade) [A]. Diese Testfälle als Spezifikation für Rollups und Import übernehmen.
- Migrationstest: SQLite-Fixture mit dem **wörtlichen** Alt-DDL oben plus synthetischen Zeilen (inkl. Waisen, offenem Incident, unregelmäßigen `ts`).

## Aufwand & Empfehlung

- **Aufwand L**: fünf Check-Typen mit Phasen-Timing, TLS-Pinning/TOFU, ICMP-Sonderweg samt Container-Konfiguration, SSRF-Sperrliste, Scheduler mit Jitter und Concurrency, Rollups, dazu der Import der Altdaten. Das Plugin ist zugleich Referenz für das SDK, weil es keinen externen Dienst braucht.
- Abhängigkeiten: Core-Metric-Store mit Rollups, Scheduler, Alert-Engine, Entity-Verknüpfung (`Service`/`Host` aus `proxmox`, `cloudflare`), Compose-Härtung des v2-LXC (`sysctls`).
- Empfohlene Welle: **1**. Die Probe-Historie soll beim Umstieg mit (ADR 0001 §6), und das Plugin ersetzt eine Kernfunktion.

## Offene Punkte

- ICMP: Darf `net.ipv4.ping_group_range` im v2-Compose gesetzt werden? Welcher Wert funktioniert im unprivilegierten LXC [?]? Ist alternativ TCP-Ping akzeptabel?
- Retention in v1 jetzt erhöhen, damit mehr Historie migriert werden kann?
- Default für `expectedStatus` bei Neu-Checks: streng (2xx/3xx/401/403/405) oder Alt-Semantik `<500`?
- Intern/extern-Paar weiter als Gruppe mit „einer down = warn“ abbilden?
- Waisen und offene Incidents beim Import übernehmen oder verwerfen?
- GeoIP streichen oder in das Router-Plugin (opt-in) verschieben?

## Quellen

1. https://github.com/nodejs/node/blob/v22.x/doc/api/tls.md – `tls.connect`-Optionen, `servername` (kein IP), `getPeerCertificate`/Zertifikatsobjekt, `secureConnect`, X509-Fehlercodes
2. https://github.com/nodejs/node/blob/v22.x/doc/api/crypto.md – `X509Certificate`, `validToDate` ab v22.10.0
3. https://github.com/nodejs/node/blob/v22.x/doc/api/dns.md – `Resolver({timeout,tries,maxTimeout})`, `setServers`, `cancel`, Fehlercodes, `lookup` vs. `resolve*`, `ttl:true`, `resolveAny`
4. https://github.com/nodejs/node/blob/v22.x/doc/api/net.md – `connect`-Optionen, `autoSelectFamily`, `setTimeout` schließt nicht, `connectionAttempt*`-Events, `BlockList`
5. https://github.com/nodejs/node/blob/v22.x/doc/api/dgram.md – nur `udp4`/`udp6`, kein ICMP
6. https://github.com/nodejs/node/blob/v22.x/doc/api/child_process.md – `execFile` ohne Shell, `timeout`, `killSignal`, `signal`
7. https://github.com/nodejs/node/blob/v22.x/doc/api/perf_hooks.md – `PerformanceResourceTiming`, `markResourceTiming`
8. https://github.com/nodejs/node/blob/v22.x/doc/api/errors.md – `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ERR_TLS_CERT_ALTNAME_INVALID`
9. https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md – `buildConnector`, eigener Connector, Fingerprint-Beispiel
10. https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md – `headersTimeout`/`bodyTimeout` 300 s, `connect`, `autoSelectFamily`, `allowH2`
11. https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md – `undici:client:beforeConnect`/`connected`, `undici:request:headers`
12. https://github.com/nodejs/undici/blob/main/docs/docs/api/Errors.md – `UND_ERR_*`-Codes
13. https://github.com/torvalds/linux/blob/master/Documentation/networking/ip-sysctl.rst – `ping_group_range`, Default `"1 0"`
14. https://github.com/torvalds/linux/blob/master/Documentation/userspace-api/no_new_privs.rst – File-Caps wirkungslos unter `no_new_privs`
15. https://github.com/moby/moby/blob/master/daemon/oci_linux.go – Docker setzt `ping_group_range "0 2147483647"` nur ohne User-Namespace
16. https://github.com/moby/moby/blob/master/daemon/pkg/oci/caps/defaults.go – `CAP_NET_RAW` im Default-Set
17. https://github.com/iputils/iputils/blob/master/ping/ping.c – `SOCK_DGRAM` zuerst, Fallback `SOCK_RAW` bei `EACCES`/`EAFNOSUPPORT`/`EPROTONOSUPPORT`
18. https://github.com/iputils/iputils/blob/master/ping/ping_common.c – Ausgaben über gettext lokalisiert
19. https://forums.docker.com/t/issue-deploying-twingate-docker-connector-on-proxmox-lxc/135837 – [S] `ping_group_range` „invalid argument“ in Proxmox-LXC
20. https://forum.proxmox.com/threads/ping-with-unprivileged-user-in-lxc-container-linux-capabilities.42308/ – [S] Ping-Probleme in unprivilegierten LXC
