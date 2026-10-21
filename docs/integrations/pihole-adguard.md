# Pi-hole v6 (`pihole`) und AdGuard Home (`adguard-home`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt
>
> Diese Datei deckt zwei Produkte ab. Gemeinsames steht einmal, Produktspezifisches ist mit
> **PH** (Pi-hole) bzw. **AGH** (AdGuard Home) markiert. Empfehlung zur Plugin-Aufteilung
> siehe [Aufwand & Empfehlung](#aufwand--empfehlung): **zwei Plugins + gemeinsames Kit**.

## Überblick

- Kategorie: DNS/Edge
- Zweck: DNS-Filter-Statistik (Anfragen, geblockt, Anteil, Top-Domains/-Clients, Upstreams) anzeigen und Blocking zeitlich begrenzt pausieren.
- **PH:** nur Pi-hole **v6** (FTL ≥ v6.0, Release 18.02.2025 [S]; aktuell FTL v6.7.1 vom 19.09.2026 [D]). Web-Server und REST-API stecken seit v6 direkt in `pihole-FTL`, Basis `/api` [D]. **Pi-hole v5 wird nicht unterstützt** (ganz andere API `/admin/api.php?…&auth=<hash>` [D]); `test()` erkennt v5 und meldet das klar (siehe Fehlercodes).
- **AGH:** AdGuard Home ≥ **v0.107.27** (erst dort gibt es `POST /control/protection` mit Dauer [D]); aktuell v0.107.79 vom 18.08.2026 [D]. Basis `/control` [D].
- Beide: rein lokale API, kein Cloud-Konto.

## Verbindung & Auth

| Aspekt | **PH** Pi-hole v6 | **AGH** AdGuard Home |
|---|---|---|
| Login | `POST /api/auth` mit `{"password":"…"}` → `session.sid`, `session.csrf`, `session.validity` (s) [D] | `POST /control/login` mit `{"name":"…","password":"…"}` → Cookie `agh_session` [D] |
| Auth je Request | Header `X-FTL-SID: <sid>` (Alternativen: Header `sid`, Query `sid`, Body-Feld `sid`, Cookie `sid`) [D] | Cookie `agh_session` **oder** `Authorization: Basic …` bei jedem Request [D] |
| CSRF | nur bei Cookie-Auth nötig (Header `X-CSRF-TOKEN` im Code, Doku nennt `X-FTL-CSRF`) – mit `X-FTL-SID` entfällt CSRF [D] | – [?] |
| Session-Lebensdauer | `webserver.session.timeout` Default **1800 s**, gleitend: jede authentifizierte Anfrage verlängert [D] | `http.session_ttl` Default **30 Tage**; Cookie-`Expires` 365 Tage [D] |
| Parallel-Sessions | **begrenzt:** `webserver.api.max_sessions` Default **16** („Seats“); voll → `429 api_seats_exceeded` [D] | keine Begrenzung bekannt [?] |
| Logout | `DELETE /api/auth` → `204` [D] | `GET /control/logout` → `302` [D] |
| 2FA | TOTP möglich; dann `totp` im Login-Body nötig – **App-Passwort umgeht TOTP** [D] | keine 2FA [?] |
| Ohne Passwort | kein Login nötig (`GET /api/auth` liefert `session.valid: true`) [D] | `users: []` → Auth deaktiviert [D] |
| Basis-URL / Port | `https://<host>/api` (443) bzw. `http://<host>/api` (80); Default-Ports `80o,443os` [D] | `http(s)://<host>:<port>/control`; Config-Default `0.0.0.0:3000`, Port im Setup frei wählbar [D] |

**Passwortarten PH** [D]:

| Art | Eignung | Begründung |
|---|---|---|
| Web-Passwort | nein | volle Rechte inkl. Config, scheitert bei aktivem TOTP |
| **App-Passwort** (`webserver.api.app_pwhash`) | **ja** | kein TOTP; mit `webserver.api.app_sudo=false` (Default) **keine Config-Änderungen** (`/api/config`, Teleporter-Import → „read-only“), Blocking/Statistik aber erlaubt |
| CLI-Passwort (`/etc/pihole/cli_pw`) | nein | wird bei jedem FTL-Neustart neu erzeugt (`webserver.api.cli_pw`) |

Es gibt **nur ein** App-Passwort pro Pi-hole. Ein neues zu erzeugen **beendet alle Sessions** und macht andere Tools, die das alte nutzen, ungültig [D].

**TLS**

- **PH:** HTTPS ist Standard. FTL erzeugt bei der Installation eine eigene CA (`CN=pi.hole,O=Pi-hole,C=DE`) und ein davon signiertes Server-Zertifikat (`/etc/pihole/tls.pem`, CA `tls_ca.crt`), Laufzeit 30 Jahre, SAN `pi.hole` + ggf. `webserver.domain` [D]. Bei IP-Zugriff passt der Hostname nie → **Fingerprint-Pinning (TOFU) ist der Normalfall**. Alternativ den CA-Fingerprint pinnen (überlebt neue Server-Zertifikate). Neu erzeugt wird z. B. nach Domainwechsel (`rm /etc/pihole/tls*` + Neustart) [D] → Pin-Mismatch sauber melden.
- **AGH:** Standard ist HTTP. HTTPS nur mit eigenem Zertifikat in den Verschlüsselungs-Einstellungen; kein automatisch erzeugtes Zertifikat [D]. Self-signed möglich → Pinning machbar. Bei HTTP gehen Basic-Credentials im Klartext durchs LAN; das Session-Cookie setzt kein `Secure` [D].

**Entwurf `configSchema` – PH (`pihole`)**

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `baseUrl` | url | ja | nein | z. B. `https://192.168.2.53` – ohne `/admin` und ohne `/api` |
| `appPassword` | string | nein | ja | App-Passwort (leer nur, wenn Pi-hole gar kein Passwort hat) |
| `tlsFingerprint` | string (SHA-256) | nein | nein | wird beim ersten Verbindungstest vorgeschlagen (TOFU) |
| `maxPauseMinutes` | int (1–1440) | nein | nein | längste Pause, die Operatoren wählen dürfen (Default 60) |
| `timeoutMs` | int | nein | nein | Default 5000 |

**Entwurf `configSchema` – AGH (`adguard-home`)**

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `baseUrl` | url | ja | nein | z. B. `http://192.168.2.54:3000` – ohne `/control` |
| `username` | string | ja* | nein | Benutzer aus `users:` in `AdGuardHome.yaml` (*leer nur ohne Auth) |
| `password` | string | ja* | ja | Passwort dieses Benutzers |
| `authMode` | enum `session`\|`basic` | nein | nein | Default `session` (spart bcrypt pro Request) |
| `tlsFingerprint` | string | nein | nein | nur bei HTTPS |
| `maxPauseMinutes` | int | nein | nein | wie PH |

## Minimale Rechte

### Nur lesen

- **PH:** Es gibt **keine Rollen**, nur Passwörter. Minimum ist das **App-Passwort** mit `app_sudo=false` [D]. Damit sind Statistik, Query-Log, Blocking **und** z. B. Domain-/Listen-Pflege möglich – nur Config und Teleporter-Import sind gesperrt [D]. Ein echtes Read-only gibt es nicht → Risiko dokumentieren; das Plugin ruft ausschließlich die in der Matrix gelisteten Pfade auf.
- **AGH:** **Kein Rechtekonzept.** Jeder Eintrag in `users:` ist Vollnutzer (Upstreams, Filter, DHCP, sogar `POST /control/update`) [D]. Wunsch nach Read-only/RBAC ist offen (Issue #997, Meilenstein v0.108.0, Priorität P4) [D]. Mitigation: eigener Benutzer `rxf-dashboard` (separat widerrufbar), Plugin-seitige Pfad-Allow-List, Web-UI nur im LAN binden.

### Zusätzlich für Aktionen

- **PH:** keine. Blocking-Pause und Gravity gehen mit App-Passwort [D]. `restartdns` braucht zusätzlich `webserver.api.allow_destructive=true` (Default `true`) [D].
- **AGH:** keine (es gibt nichts zu erweitern) [D].

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

**PH – App-Passwort** ([Doku](https://docs.pi-hole.net/api/auth/))

1. Pi-hole-Weboberfläche öffnen → **Settings → Web interface / API** [D]. `[Screenshot: Pi-hole Settings-Menü]`
2. Oben rechts **Expert** einschalten – die Box „Advanced Settings“ ist sonst ausgeblendet [D]. `[Screenshot: Basic/Expert-Schalter]`
3. **Configure app password** → Passwort kopieren (wird nur einmal angezeigt) → **Enable new app password** [D]. Hinweis im Assistenten: „Alle anderen Apps mit App-Passwort werden abgemeldet.“ `[Screenshot: App-Passwort-Dialog]`
4. Prüfen, dass **`webserver.api.app_sudo` aus** ist (Default) [D].
5. URL + App-Passwort eintragen → „Verbindung testen“ → Zertifikats-Fingerprint bestätigen.

**AGH – eigener Benutzer** ([Wiki Configuration](https://github.com/AdguardTeam/AdGuardHome/wiki/Configuration))

1. Benutzer lassen sich nur in `AdGuardHome.yaml` anlegen (keine UI-Verwaltung [?]). AdGuard Home stoppen. `[Screenshot: Dienst stoppen]`
2. bcrypt-Hash erzeugen, z. B. `htpasswd -B -C 10 -n -b rxf-dashboard '<passwort>'` [D Wiki: `htpasswd` mit bcrypt].
3. Unter `users:` ergänzen: `- name: rxf-dashboard` / `password: <hash>` [D]. AdGuard Home starten.
4. Alternativ (einfacher, schlechter): bestehenden Admin-Benutzer nutzen – im Assistenten als Warnung anzeigen.
5. URL, Benutzer, Passwort eintragen → „Verbindung testen“.

## Fähigkeitsmatrix

### Daten – PH Pi-hole v6 (`/api`)

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Kennzahlen: `queries.total`, `.blocked`, `.percent_blocked`, `.unique_domains`, `.forwarded`, `.cached`, `clients.active/total`, `gravity.domains_being_blocked`, `gravity.last_update` | `GET /stats/summary` | `Metric` + `Service` | 15 s / 5 min | [D] |
| Blocking-Status (`enabled`/`disabled`/`failed`/`unknown`) + Rest-`timer` (s) | `GET /dns/blocking` | `Service` (disabled → `paused`) | 15 s / 5 min | [D] |
| Verlauf 24 h in 10-min-Slots (`timestamp`, `total`, `cached`, `blocked`, `forwarded`) | `GET /history` | `Metric` | 5 min / 30 min | [D] |
| Top-Domains erlaubt / geblockt | `GET /stats/top_domains?count=10` bzw. `&blocked=true` | plugin-spezifisch | 60 s / 15 min | [D] |
| Top-Clients | `GET /stats/top_clients?count=10` | `Client` | 60 s / 15 min | [D] |
| Upstreams (`ip`, `name`, `port`, `count`, `statistics.response`) | `GET /stats/upstreams` | plugin-spezifisch | 60 s / 15 min | [D] |
| Query-Typen | `GET /stats/query_types` | `Metric` | 5 min / 30 min | [D] |
| Zuletzt geblockt | `GET /stats/recent_blocked?count=10` | plugin-spezifisch | 30 s / – | [D] |
| Query-Log (paginiert, Filter `domain`, `client_ip`, `status`, …) | `GET /queries?length=50&cursor=…` | plugin-spezifisch | nur auf Seite | [D] |
| Versionen `version.core/web/ftl.local/remote`, `docker` | `GET /info/version` | `Service` | 6 h / 24 h | [D] |
| FTL: `privacy_level`, `uptime`, `%cpu`, `%mem`, `allow_destructive` | `GET /info/ftl` | `Service` | 5 min / 30 min | [D] |
| System: `uptime`, RAM, Load | `GET /info/system` | `Host` (optional) | 60 s / 15 min | [D] |
| Diagnose-Meldungen | `GET /info/messages/count`, Details `GET /info/messages` | `Alert` | 5 min / 30 min | [D] |
| Erkennung v6, `https_port`, `dns` (DNS läuft?) – **ohne Auth** | `GET /info/login` | – | `test()` + 60 s | [D] |
| Eigene Sessions (`app`, `user_agent`, `valid_until`) | `GET /auth/sessions` | – | `test()` / Aufräumen | [D] |
| Sammelabruf für PADD (Alternative zu mehreren Calls) | `GET /padd` (`?full=true`) | – | optional | [D] Semantik von `full` [?] |

### Daten – AGH AdGuard Home (`/control`)

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| `running`, `protection_enabled`, `protection_disabled_duration` (ms), `version`, `dns_addresses`, `dns_port`, `http_port` | `GET /status` | `Service` (Schutz aus → `paused`) | 15 s / 5 min | [D] |
| `num_dns_queries`, `num_blocked_filtering`, `num_replaced_safebrowsing/_safesearch/_parental`, `avg_processing_time`, Reihen `dns_queries[]`, `blocked_filtering[]`, `time_units` | `GET /stats` (ab v0.107.72 `?recent=86400000` für 24 h) | `Metric` | 30 s / 10 min | [D] |
| Top-Domains, Top-geblockt, Top-Clients, Upstreams (Antworten, Ø-Zeit) | im selben `GET /stats`: `top_queried_domains`, `top_blocked_domains`, `top_clients`, `top_upstreams_responses`, `top_upstreams_avg_time` | plugin-spezifisch / `Client` | (gleicher Abruf) | [D] |
| Statistik-Fenster (`enabled`, `interval` ms, `ignored`) | `GET /stats/config` | – | 6 h | [D] |
| Query-Log | `GET /querylog?limit=50&older_than=…&search=…&reason=…` | plugin-spezifisch | nur auf Seite | [D] |
| Query-Log-Konfig (`anonymize_client_ip`, `interval`) | `GET /querylog/config` | – | 6 h | [D] |
| Filterlisten-Status | `GET /filtering/status` | plugin-spezifisch | 30 min / 6 h | [D] Felder [?] |
| Safebrowsing / Kindersicherung / SafeSearch | `GET /safebrowsing/status`, `/parental/status`, `/safesearch/status` | – | 30 min | [D] |
| Konfigurierte Clients | `GET /clients` | `Client` | 15 min / 1 h | [D] |
| Update verfügbar (kontaktiert AdGuard-Server) | `POST /version.json` (`recheck_now:false`) | `Service` | 24 h | [D] |

### Aktionen – PH Pi-hole v6

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Blocking pausieren (N min) | `POST /api/dns/blocking` `{"blocking":false,"timer":<Sekunden>}` | low | operator | – | [D] |
| Blocking dauerhaft aus | dito, `"timer":null` | medium | admin | – | [D] |
| Blocking an / Timer abbrechen | `{"blocking":true,"timer":null}` | low | operator | – | [D] |
| Blocklisten aktualisieren (Gravity) | `POST /api/action/gravity` (streamt `text/plain`, dauert Minuten) | low | operator | – | [D] |
| DNS-Dienst neu starten | `POST /api/action/restartdns` | medium (kurzer DNS-Ausfall für alle Clients) | admin | `allow_destructive` | [D] |
| Logs / Netzwerktabelle leeren | `POST /api/action/flush/logs`, `/flush/network` | high (Datenverlust) | **nicht anbieten** | `allow_destructive` | [D] |

### Aktionen – AGH AdGuard Home

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Schutz pausieren (N min) | `POST /control/protection` `{"enabled":false,"duration":<Millisekunden>}` | low | operator | – | [D] |
| Schutz dauerhaft aus | `{"enabled":false}` ohne `duration` | medium | admin | – | [D] |
| Schutz an | `{"enabled":true}` | low | operator | – | [D] |
| DNS-Cache leeren | `POST /control/cache_clear` | low | operator | – | [D] |
| Filterlisten aktualisieren | `POST /control/filtering/refresh` | low | operator | – | [D] Body [?] |
| Selbst-Update | `POST /control/update` | high | **nicht anbieten** | – | [D] |

Audit-Text-Vorschlag: „{user} hat das DNS-Blocking auf {instanz} für {n} min pausiert.“ Pause-Dauer normalisiert das Kit (PH Sekunden ↔ AGH Millisekunden).

### Widgets (Vorschlag)

Identisch für beide Plugins (gemeinsames Kit, normalisiertes Datenmodell `DnsFilterSnapshot`):

| Widget | Inhalt | Größen |
|---|---|---|
| DNS-Filter-Status | Anfragen 24 h, geblockt, Anteil %, Badge „aktiv“ / „pausiert bis hh:mm“ | S, M |
| Blocking-Schalter | Toggle + Pausen-Chips 5/15/60 min, Countdown | S |
| Verlauf | gestapelte Fläche erlaubt/geblockt (PH 10-min-Slots, AGH stündlich laut `time_units` [?]) | M, L |
| Top-Domains | Tabs „erlaubt“ / „geblockt“, Top 10 | M, L |
| Top-Clients | Top 10 mit Name/IP | M |
| Upstreams | Anteil + Ø-Antwortzeit | M |
| Mehrinstanz | Summe/Vergleich mehrerer Instanzen (z. B. Pi-hole-Paar oder PH + AGH) | L, XL |

### Seiten (Vorschlag)

- **DNS-Filter** (pro Instanz): Kennzahlen, Verlauf, Top-Listen, Upstreams, Query-Log (nur bei geöffneter Seite, paginiert, Filter „nur geblockt“), Versionen/Updates, bei PH Diagnose-Meldungen.

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| DNS-Filter nicht erreichbar | Collector-Fehler > 2 min | crit |
| DNS-Dienst läuft nicht | PH `info/login.dns == false` · AGH `status.running == false` | crit |
| Blocking dauerhaft aus | PH `blocking=disabled` + `timer=null` · AGH `protection_enabled=false` + Dauer 0, jeweils > 15 min | warn |
| Blocklisten veraltet | PH `gravity.last_update` älter als 8 Tage | warn |
| Auffällige Blockrate | Anteil geblockt < 1 % oder > 60 % über 1 h | warn |
| Pi-hole meldet Probleme | `info/messages/count > 0` | warn |
| Plugin kann sich nicht anmelden (Seats voll) | PH `429 api_seats_exceeded` | crit |
| Update verfügbar | PH `local != remote` · AGH `version.json` meldet neue Version | info |

## Rate-Limits & Last

- **PH Login-Drossel:** max. **3 Passwortversuche pro Sekunde** (global, nicht pro IP), danach 250 ms Pause + `429 rate_limiting` [D]. Login nie parallel: Mutex pro Instanz.
- **PH Seats (wichtigste Stolperfalle):** 16 Sessions; jede verwaiste Session blockiert ihren Seat bis zu 30 min [D]. Ein Login pro Poll würde die Seats in Minuten füllen und **auch den Admin im Browser aussperren**. Regeln für den Session-Manager:
  1. **Eine** Session pro Instanz, `sid` im Speicher halten und für alle Requests wiederverwenden (gleitende Verlängerung hält sie bei Polling < 30 min am Leben).
  2. Bei `401` genau **einmal** neu anmelden, dann Fehler melden (kein Login-Sturm).
  3. Beim Deaktivieren des Plugins / sauberen Shutdown `DELETE /api/auth`. `test()` meldet sich **immer** ab.
  4. Eindeutigen `User-Agent` (z. B. `rxf-admin/2 (pihole-plugin)`) senden; nach Absturz eigene Alt-Sessions über `GET /api/auth/sessions` finden und mit `DELETE /api/auth/session/{id}` freigeben [D Endpunkte; Erkennung per UA ist Plugin-Logik].
  5. Optional `sid` verschlüsselt persistieren: FTL stellt Sessions nach Neustart wieder her (`webserver.session.restore`, Default `true`) [D].
- **PH Last:** Statistik kommt aus dem RAM (24 h), billig. `/stats/database/*`, `/history/database*` und `/queries?disk=true` lesen SQLite → nur auf Nutzeranfrage. Gravity läuft minutenlang und streamt → eigener langer Timeout.
- **AGH Login-Sperre:** **5 Fehlversuche → 15 min Sperre** (`auth_attempts`, `block_auth_min`), Schlüssel ist die Socket-IP; `429` mit `Retry-After` [D]. Steht das Dashboard hinter demselben Proxy wie die Nutzer, sperren Fehlversuche alle aus.
- **AGH Basic-Auth:** jeder Request prüft das bcrypt-Passwort [D] → spürbare CPU-Last auf kleinen Geräten. Deshalb Default `session`: einmal `POST /control/login`, Cookie wiederverwenden, bei `401` einmal neu anmelden.
- **AGH Last:** `/stats` liefert Top-Listen gleich mit (ein Call pro Zyklus). `/querylog` liest Dateien → nur on-demand, kleines `limit`.

## Verbindungstest & Fehlercodes

**Ablauf PH:** `GET /api/info/login` (ohne Auth, erkennt v6) → `GET /api/auth` (Passwort nötig?) → `POST /api/auth` → `GET /api/auth/sessions` (eigene Session `app:true`?) → `GET /api/info/version` → `GET /api/stats/summary` → `DELETE /api/auth`.
**v5-Erkennung:** Liefert `/api/info/login` `404`/HTML, dann `GET /admin/api.php?versions` (in v5 ohne Auth [D]); JSON mit `core_current` = `v5.*` → `PIHOLE_V5_UNSUPPORTED`.
**Ablauf AGH:** `GET /control/status` ohne Auth (`200` → keine Auth aktiv; `401` → Auth aktiv) → `POST /control/login` → `GET /control/status` (Version prüfen) → `GET /control/stats` → `GET /control/logout`.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | DNS-/TCP-Fehler, Timeout | „Host nicht erreichbar. Adresse und Port prüfen.“ |
| `CERT_UNKNOWN` | TLS-Fehler ohne Pin | „Zertifikat unbekannt (selbstsigniert). Fingerprint prüfen und vertrauen?“ |
| `CERT_PIN_MISMATCH` | Fingerprint ≠ Pin | „Zertifikat hat sich geändert. Wurde Pi-hole neu installiert oder die Domain geändert?“ |
| `PIHOLE_V5_UNSUPPORTED` | siehe v5-Erkennung | „Pi-hole v5 erkannt ({version}). Unterstützt wird nur Pi-hole v6 – bitte aktualisieren.“ |
| `NOT_PIHOLE` / `NOT_ADGUARD` | weder v6- noch v5-Antwort bzw. kein `/control/status`-JSON | „Unter dieser Adresse läuft kein Pi-hole v6 / AdGuard Home.“ |
| `BAD_PASSWORD` | PH `401` auf `POST /api/auth`; AGH `400` auf `/control/login` [D] | „Passwort bzw. Benutzer falsch.“ |
| `TOTP_REQUIRED` | PH `session.totp=true`, Login ohne TOTP abgelehnt | „Zwei-Faktor ist aktiv. Bitte ein App-Passwort verwenden.“ |
| `SEATS_EXCEEDED` | PH `429` + `api_seats_exceeded` [D] | „Pi-hole hat keine freien API-Sitzungen (max. {n}). Alte Sitzungen beenden oder `webserver.api.max_sessions` erhöhen.“ |
| `RATE_LIMITED` | PH `429` + `rate_limiting`; AGH `429` + `Retry-After` | „Zu viele Anmeldeversuche. Erneut in {s} s.“ |
| `MAIN_PASSWORD_USED` (Warnung) | PH eigene Session hat `app:false` | „Das ist das Web-Passwort. Empfohlen: App-Passwort (weniger Rechte).“ |
| `NO_AUTH` (Warnung) | PH `GET /api/auth` valid ohne Login; AGH `/control/status` ohne Auth `200` | „Kein Passwort gesetzt – jeder im Netz kann den DNS-Filter steuern.“ |
| `VERSION_TOO_OLD` | AGH `version` < v0.107.27; PH FTL < v6.0 | „Version {v} zu alt (mindestens {min}).“ |
| `ACTION_FORBIDDEN` | PH `403` bei `restartdns` | „Pi-hole erlaubt diese Aktion nicht (`webserver.api.allow_destructive`).“ |
| `AGH_NOT_CONFIGURED` | Redirect auf `/install.html` [?] | „AdGuard Home ist noch nicht eingerichtet.“ |

## Eigenheiten & Stolperfallen

- **PH** Nur **ein** App-Passwort; Neuerzeugung meldet alle Apps ab (Home Assistant, Homepage, …) [D] → im Onboarding fragen, ob schon eines existiert, und dann dasselbe verwenden.
- **PH** Doku sagt „Sessions sind an die Client-IP gebunden“, der Code von `auth.c` speichert `remote_addr` aber nur für Anzeige/Log [D] – Verhalten bei IP-Wechsel [?]; das Dashboard hat ohnehin eine feste IP.
- **PH** `misc.privacylevel` > 0 versteckt Domains/Clients in Statistik und Log [D] → Top-Listen leer, kein Fehler. Im Widget „durch Datenschutzstufe ausgeblendet“ anzeigen (`/info/ftl.privacy_level`).
- **PH** Hostname im Zertifikat ist `pi.hole` (+ ggf. `webserver.domain`); bei IP-URL immer Mismatch → Pinning statt Hostnamensprüfung, bewusst im SDK-TLS-Helper.
- **PH** `GET /api/history` liefert nur die In-Memory-Spanne (`MAXLOGAGE` 24 h, Slots 600 s) [D].
- **AGH** `protection_disabled_duration` ist eine Restdauer in **ms** [D]; das Feld hieß in der Spec teils `protection_disabled_until` (Spec-Korrektur in v0.107.79) [D] → beide Namen tolerant lesen.
- **AGH** Statistik-Fenster ist konfigurierbar (`interval` bis 8760 h) [D]; ohne `recent` sind die Summen **nicht** 24 h → ab v0.107.72 `recent=86400000` senden, sonst Fenster im Widget anzeigen.
- **AGH** Top-Listen sind Arrays aus Ein-Schlüssel-Objekten (`[{"example.org": 42}, …]`) [D].
- **AGH** `response_status` im Query-Log ist deprecated, Ersatz `reason` (ab v0.107.77) [D].
- **Beide** Pausendauer: PH Sekunden, AGH Millisekunden – nur im Adapter umrechnen, nie im Widget.

## Wissen aus dem Altcode

Keine Altintegration.

## Testbarkeit (Vertragstests)

- **PH:** offizielle OpenAPI-Spec im FTL-Repo (`src/api/docs/content/specs/*.yaml`, Einstieg `main.yaml`) und live unter `/api/docs` (ohne Auth) [D]. Fixtures einmalig gegen einen Pi-hole-v6-Container aufzeichnen, im CI gegen die Spec validieren.
- **AGH:** offizielle `openapi/openapi.yaml` + `openapi/CHANGELOG.md` im Repo [D]. Fixtures aus einem AdGuard-Home-Container aufzeichnen.
- Pflicht-Szenarien: PH v5-Antwort (`/admin/api.php?versions`), `429 api_seats_exceeded`, `401` mit `totp:true`, Blocking `disabled` mit Timer, Privacy-Level 3 (leere Top-Listen), `403` bei `allow_destructive=false`; AGH `400` Login, `429` + `Retry-After`, Schutz pausiert, Stats-Fenster 7 Tage.
- Session-Manager separat testen: genau ein Login bei 20 parallelen Collector-Aufrufen; Re-Login bei `401` genau einmal; `DELETE /api/auth` beim Stop.
- Keine Alt-Fixtures vorhanden.

## Aufwand & Empfehlung

**Empfehlung: zwei Plugins (`pihole`, `adguard-home`) plus ein gemeinsames internes Paket `dns-filter-kit`.** Kein Ein-Plugin-mit-zwei-Adaptern.

| Kriterium | Unterschiedlich | Gemeinsam |
|---|---|---|
| `configSchema` | PH nur Passwort, AGH Benutzer + Passwort + Auth-Modus | URL, Fingerprint, `maxPauseMinutes` |
| `test()` / Fehlercodes | v5-Erkennung, Seats, TOTP vs. Login-Sperre, Install-Status | Netzwerk/TLS-Codes |
| Auth-Lebenszyklus | Seat-sparende Sessions vs. Cookie/Basic | – |
| Onboarding-Anleitung | App-Passwort in UI vs. YAML-Benutzer | – |
| Versionierung | FTL v6.x vs. v0.107.x, getrennte Spec-Changelogs | – |
| Widgets, Alarme, Aktion „Pause“ | – | fast identisch |

Begründung: Alles, was das SDK pro Plugin verlangt (Manifest, Schema, `test()`, Collector-Auth, Onboarding, Migrationen), ist verschieden. Ein Kombi-Plugin bräuchte ein diskriminiertes Schema (`flavor`) mit bedingten Feldern im Formular-Generator, zwei Fixture-Sätze und gekoppelte Releases. Das Gemeinsame (normalisiertes `DnsFilterSnapshot`, Widgets, Alarmvorlagen, Aktionsdefinition „Pause N min“) passt in ein Kit, das beide Plugins importieren. Für den Nutzer sind es zwei klar benannte Katalog-Einträge mit eigenem Icon. Gleiche Metric-Namen (z. B. `dns.queries.total`, `dns.queries.blocked`) erlauben trotzdem ein Instanz-übergreifendes Widget.

- Aufwand: **Kit S**, **`pihole` M** (Session-/Seat-Manager, TLS-Pinning, v5-Erkennung), **`adguard-home` S** → zusammen **M**.
- Abhängigkeiten: SDK-TLS-Helper mit Pinning, generischer Session-Helper (einmal anmelden, Mutex, ein Re-Login bei `401`, Abmelden beim Stop), Aktions-Parameter mit Min/Max (Pause), Status `paused` an `Service`.
- Welle: **Welle 2** (neue Plugins), früh darin – lesend einfach, guter Testfall für Kit-Wiederverwendung und zeitbegrenzte Aktionen. `pihole` zuerst.

## Offene Punkte

1. Welches Produkt läuft beim Owner (Pi-hole, AdGuard Home, beide, Pi-hole-Paar)? Danach Reihenfolge festlegen.
2. Nutzt schon ein anderes Tool das Pi-hole-App-Passwort? Dann wiederverwenden statt neu erzeugen.
3. Dürfen Operatoren Blocking **dauerhaft** abschalten oder nur mit Timer? Maximaldauer?
4. AGH: Ist ein eigener YAML-Benutzer für das Dashboard akzeptabel?
5. PH: Bindung der Session an die IP (Doku vs. Code) [?]; Bedeutung von `GET /api/padd?full=true` [?].
6. AGH: genaue Antwort bei nicht eingerichteter Instanz und Feldnamen von `/control/filtering/status` [?].

## Quellen

1. https://github.com/pi-hole/FTL/blob/master/src/api/docs/content/specs/main.yaml – Pfadliste, Server `https://pi.hole:443/api`, Security-Schemes `X-FTL-SID`/`sid`
2. https://github.com/pi-hole/FTL/blob/master/src/api/docs/content/specs/auth.yaml – Login/Logout, Session-Felder, 30-min-Timeout, `api_seats_exceeded`, App-Passwort beendet Sessions
3. https://github.com/pi-hole/FTL/blob/master/src/api/auth.c – SID-Quellen, Seat-Vergabe, App-Passwort ohne TOTP, CSRF nur bei Cookie
4. https://github.com/pi-hole/FTL/blob/master/src/config/config.c – Defaults `max_sessions` 16, `session.timeout` 1800, `cli_pw`, `app_sudo`, `allow_destructive`, Ports, `privacylevel`
5. https://github.com/pi-hole/FTL/blob/master/src/config/password.c und `password.h` – Prüfreihenfolge CLI/Web/App, 3 Versuche pro Sekunde
6. https://github.com/pi-hole/FTL/blob/master/src/api/config.c und `teleporter.c` – `app_sudo`-Sperre nur für Config/Teleporter
7. https://github.com/pi-hole/FTL/blob/master/src/api/api.c – welche Pfade ohne Auth, `404 not_found`
8. https://github.com/pi-hole/FTL/blob/master/src/api/docs/content/specs/stats.yaml, `dns.yaml`, `history.yaml`, `info.yaml`, `queries.yaml`, `padd.yaml`, `action.yaml` – Felder und Parameter
9. https://github.com/pi-hole/FTL/blob/master/src/api/action.c – `allow_destructive`-Prüfung, Gravity-Streaming
10. https://github.com/pi-hole/FTL/blob/master/src/FTL.h – `MAXLOGAGE` 24 h, `OVERTIME_INTERVAL` 600 s
11. https://github.com/pi-hole/FTL/blob/master/src/webserver/x509.c – eigene CA, 30 Jahre, SAN `pi.hole`
12. https://github.com/pi-hole/docs/blob/master/docs/api/auth.md – SID-Übergabe, begrenzte Sessions, Logout-Empfehlung, App-Passwort bei 2FA
13. https://github.com/pi-hole/docs/blob/master/docs/api/tls.md – selbstsigniertes Zertifikat, CA-Import, eigenes Zertifikat
14. https://github.com/pi-hole/web/blob/master/settings-api.lp und `scripts/lua/sidebar.lp` – Menü „Web interface / API“, Expert-Box, App-Passwort-Dialog
15. https://github.com/pi-hole/AdminLTE/blob/v5.21/api.php – v5-API (`?versions` ohne Auth, `core_current`, `auth`-Parameter)
16. https://github.com/pi-hole/FTL/releases – aktuelle Version v6.7.1 (19.09.2026)
17. https://pi-hole.net/blog/2025/02/18/introducing-pi-hole-v6/ – v6-Release 18.02.2025, Upgrade nur in eine Richtung [S]
18. https://github.com/AdguardTeam/AdGuardHome/blob/master/openapi/openapi.yaml – `/control`, `basicAuth`, `ServerStatus`, `Stats`, `SetProtectionRequest`, Query-Log
19. https://github.com/AdguardTeam/AdGuardHome/blob/master/openapi/CHANGELOG.md – `/protection` ab v0.107.27, `recent` ab v0.107.72, `reason` ab v0.107.77, Feld-Umbenennung v0.107.79, `429` ab v0.106
20. https://github.com/AdguardTeam/AdGuardHome/blob/master/internal/home/authhttp.go – Cookie `agh_session`, Basic-Auth pro Request, Rate-Limiter per Socket-IP, öffentliche Pfade
21. https://github.com/AdguardTeam/AdGuardHome/blob/master/internal/home/config.go – Defaults `AuthAttempts` 5, `AuthBlockMin` 15, `SessionTTL` 30 Tage, Port 3000
22. https://github.com/AdguardTeam/AdGuardHome/blob/master/internal/aghuser/aghuser.go – bcrypt
23. https://github.com/AdguardTeam/AdGuardHome/wiki/Configuration und `/wiki/Encryption` – `users`, `auth_attempts`, eigenes Zertifikat nötig
24. https://github.com/AdguardTeam/AdGuardHome/issues/997 (+ #3806, #1245) – kein Rollenmodell, Feature offen
25. https://github.com/AdguardTeam/AdGuardHome/releases – aktuelle Version v0.107.79 (18.08.2026)
