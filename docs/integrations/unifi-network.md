# UniFi Network (`unifi-network`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt · [D*] Sekundärquelle geöffnet (gepflegte Bibliothek / Community-Doku auf GitHub, **nicht** Hersteller)
>
> developer.ui.com ist per DNS gesperrt. Die OpenAPI-Spezifikationen von Network (v9.1.120 bis v10.6.106) und Site Manager (v1.0.0) wurden über den täglich synchronisierten Spiegel `opastorello/unifi-api-docs` gelesen, der die Herstellerspezifikation unverändert extrahiert. Diese Angaben sind als [D] markiert.

## Überblick

- Kategorie: Netzwerk
- Zweck: Gateway, Switches und APs mit Status/Firmware, Clients (gesamt, pro AP), WAN und ISP-Qualität anzeigen. Geräte-Neustart und PoE-Power-Cycle als opt-in-Aktionen.
- Drei API-Flächen:

| API | Basis-URL | Auth | Liefert |
|---|---|---|---|
| Integration API (lokal, offiziell, versioniert) | `https://<console>/proxy/network/integration/v1/...` | `X-API-KEY` | Sites, Geräte, Clients, Gerätestatistik, Aktionen [D] |
| Legacy-Controller-API (lokal, inoffiziell) | `https://<console>/proxy/network/api/s/<site>/...` | Cookie-Login **oder** `X-API-KEY` | WAN-Durchsatz, ISP-Name, Speedtest [A][D*] |
| Site Manager API (Cloud) | `https://api.ui.com/v1/...` | `X-API-Key` (Cloud-Key) | Hosts, Sites, Firmwarestatus, ISP-Metriken [D] |

- Versionen: Integration API erstmals mit Network 9.0.92, laut Release-Notes-Spiegel auf Cloud Gateways mit UniFi OS ≥ 4.1.9 [S]. Ältester gespiegelter Spec-Stand 9.1.120: 15 Operationen, Aktionen und `statistics/latest` schon enthalten [D]. 10.0.162 ergänzt u. a. `/networks` und `/wans` (50 Operationen) [D]. Aktuell ist 10.6.106 mit 73 Operationen [D]. Owner: Network 10.3.58 auf UCG Ultra [A backend/tests/test_unifi.py:31].
- Lokal vs. Cloud: Kern ist lokal. Site Manager ist optional, nur für ISP-Metriken. Die Remote-Variante der Integration API (`https://api.ui.com/v1/connector/consoles/{consoleId}/network/integration/...` mit Cloud-Key [D], Konsolen-Firmware ≥ 5.0.3, ca. 800 ms Zusatzlatenz [D*]) braucht das MVP nicht.

## Verbindung & Auth

- **Lokal, empfohlen:** Header `X-API-KEY: <key>`, zustandslos, kein Login [D][D*]. Header-Namen sind case-insensitive; die Spec-Beispiele nutzen lokal `X-API-KEY`, remote `X-API-Key` [D].
- Paging lokal: `offset` (Default 0) und `limit` (Default 25), Antwort `{offset, limit, count, totalCount, data}` [D]. Ein Maximum für `limit` dokumentiert die Spec nicht; der Altcode nimmt 200 an [A backend/app/clients/unifi.py:90-93][?].
- Filter: Query-Parameter `filter`, z. B. `access.type.eq('GUEST')` [D].
- **Cloud:** `https://api.ui.com/v1/...`, Header `X-API-Key` [D]. Paging über `pageSize` und `nextToken` [D]. Ein Cloud-Key funktioniert lokal **nicht** (401) [D*].
- **Altapp, Variante A (Cookie):** `POST /api/auth/login` mit `{username, password}`. Cookie und `X-CSRF-Token` stammen aus der Antwort, Re-Login nach 1800 s oder bei 401 [A backend/app/clients/unifi.py:400-437]. Funktioniert nur mit lokalen Admins, nicht mit Cloud-, SSO- oder 2FA-Konten [A docs/SETUP.md:138-149][D*].
- **Altapp, Variante B (API-Key):** Integration API mit Key. Die Altapp ergänzt sie per Cookie-Login um Legacy-Daten, wenn Benutzername und Passwort gesetzt sind [A backend/app/clients/unifi.py:625-651]. Laut Art-of-WiFi-Client funktioniert der Key auch direkt auf den Legacy-Pfaden `/proxy/network/api/s/<site>/...`, ohne Login [D*].
- **Empfehlung:** Das Plugin unterstützt **nur den API-Key**. Legacy-Statistiken holt es mit demselben Key als abschaltbares Zusatzmodul `legacyStats`, Cookie-Auth entfällt. Begründung: keine gespeicherten Admin-Passwörter, keine Session-, Lock- oder CSRF-Logik (Altcode-Globals [A backend/app/clients/unifi.py:38-47]), kein Konflikt mit 2FA.
- **TLS:** Die Konsole liefert auf der LAN-IP ein selbstsigniertes Zertifikat [D*]. Die Altapp schaltet die Prüfung ab [A backend/app/config.py:87, backend/app/clients/unifi.py:636]. Pinning ist machbar: SHA-256 des SPKI beim ersten Kontakt speichern (TOFU). Bei einem Wechsel (Reset, Firmware-Update, eigenes Zertifikat [?]) fragt das Plugin erneut nach. Alternativ hat `<id>.id.ui.direct` ein gültiges Zertifikat und löst auf die LAN-IP auf [D*], braucht aber externes DNS [?]. Site Manager nutzt normale CA-Prüfung.

**Entwurf `configSchema`:**

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `host` | string (IP/Hostname) | ja | nein | IP der UniFi-Konsole, z. B. `192.168.2.1` (nur diese Adresse wird kontaktiert, SSRF-Allowlist) |
| `port` | int | nein (443) | nein | HTTPS-Port der Konsole |
| `apiKey` | string | ja | ja | Lokaler Network-API-Key (Integrations-Seite der Konsole), **kein** Key von unifi.ui.com |
| `site` | string | nein (`default`) | nein | Site-Name, `internalReference` oder UUID |
| `tlsPin` | string (sha256) | auto | nein | Fingerabdruck, wird bei „Verbindung testen“ gesetzt und bestätigt |
| `legacyStats` | bool | nein (true) | nein | WAN-Durchsatz, ISP und Speedtest über Legacy-Endpunkt (gleicher Key) |
| `siteManagerApiKey` | string | nein | ja | Optional: Cloud-Key für ISP-Metriken (Latenz, Paketverlust) |
| `siteManagerHostId` | string | nein | nein | Nur bei mehreren Konsolen im UI-Konto |

## Minimale Rechte

### Nur lesen

- **Lokaler Key:** Es gibt kein Scope- oder Read-only-Modell. Der Key erbt die Rechte des Admins, der ihn erstellt [D*]. Erstellen dürfen laut Berichten nur Owner und Super Admin [S]. Ein schreibgeschützter lokaler Key lässt sich damit nach heutigem Stand nicht erzeugen [?]. Das Plugin erzwingt Lesen selbst: im Collector nur `GET`, eine Allowlist der Pfade, Aktionen per Default aus.
- **Site-Manager-Key:** laut Herstellerdoku „derzeit read-only“ [S]. Die Spec enthält nur `GET`-Operationen und eine `POST`-Abfrage (`/query`) [D].
- **Legacy-Cookie (nicht empfohlen):** Nur hier ist echtes Read-only möglich, über einen lokalen Admin mit Rolle „Read Only“ [A docs/SETUP.md:140-143].

### Zusätzlich für Aktionen

- Kein Zusatzrecht nötig oder vergebbar: Derselbe Key darf schon `RESTART`, `POWER_CYCLE` und alle `POST`/`PUT`/`DELETE`-Operationen (Netzwerke, Firewall, WLANs) [D]. Absicherung im Plugin: Aktionen opt-in. Der HTTP-Client erlaubt `POST` nur auf `.../devices/{id}/actions` und `.../interfaces/ports/{idx}/actions`, Body-Whitelist `RESTART` bzw. `POWER_CYCLE`.

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

1. Lokal an der Konsole anmelden, nicht über unifi.ui.com (der Cloud-Proxy blendet die Seite aus [D*]), mit einem Owner- oder Super-Admin-Konto [S]. `[Screenshot: UniFi-Login lokal]`
2. Integrations-Seite öffnen: Network 10.x unter `https://<console>/network/default/integrations` [D*], ältere Versionen unter *Settings › Control Plane › Integrations* [A docs/SETUP.md:122][S]. `[Screenshot: Integrations-Seite]`
3. **Create New API Key**, Name `rxf-admin-v2`. Ablaufoptionen, falls angeboten, übernehmen [?]. `[Screenshot: Dialog Create API Key]`
4. Key sofort kopieren, er wird nur einmal angezeigt [D*]. In den Assistenten einfügen, dann **Verbindung testen** und den TLS-Fingerabdruck bestätigen. `[Screenshot: Fingerabdruck-Dialog]`
5. Optional ISP-Metriken: auf `unifi.ui.com` → **API** → **Create API Key** [S] und im Feld `siteManagerApiKey` eintragen. Doku: https://developer.ui.com/site-manager-api/gettingstarted
6. Hinweis im Assistenten: Der Key hat volle Admin-Rechte. Widerruf durch Löschen auf derselben Seite.

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| App-Version | `GET /v1/info` → `applicationVersion` | – (Plugin-Health) | Test + 6 h | [D] |
| Sites | `GET /v1/sites` → `id`, `internalReference`, `name` | – (Config) | Start + 1 h | [D] |
| Geräte inkl. Status/Firmware | `GET /v1/sites/{siteId}/devices` → `id`, `name`, `model`, `macAddress`, `ipAddress`, `state` (ONLINE, OFFLINE, UPDATING, ADOPTING, CONNECTION_INTERRUPTED, …), `firmwareVersion`, `firmwareUpdatable`, `features` (`switching`/`accessPoint`/`gateway`) | `NetworkDevice` | 30 s / 300 s | [D] |
| Topologie, Ports, PoE, Funk | `GET .../devices/{deviceId}` → `uplink.deviceId`, `interfaces.ports[]` (`idx`, `state`, `speedMbps`, `poe.enabled/state/standard`), `radios[]` | `NetworkDevice` (Plugin-Daten) | 300 s / 1800 s | [D] |
| CPU/RAM/Uptime/Uplink-Rate | `GET .../devices/{deviceId}/statistics/latest` → `uptimeSec`, `cpuUtilizationPct`, `memoryUtilizationPct`, `loadAverage1Min`, `uplink.rxRateBps/txRateBps`, `radios[].txRetriesPct` | `Metric` | 30 s / 300 s (pro Gerät) | [D] |
| Clients gesamt | `GET .../clients` → `totalCount`; Typ `WIRED`/`WIRELESS`/`VPN`/`TELEPORT`, `name`, `ipAddress`, `connectedAt`, `access` | `Client` | 60 s / 300 s | [D] |
| Clients pro AP | Varianten-Feld `uplinkDeviceId` (+ `macAddress`) der Clients, aggregiert pro Gerät | `Client` → `NetworkDevice` | mit Clients | [D] Spec v9.x, in 10.x-Variante nicht nachgeprüft [?]; real beobachtet 10.3.58 [A backend/tests/test_unifi.py:66-77] |
| Netzwerke/VLANs | `GET .../networks` | Plugin-Daten | 1 h | [D] |
| WAN-Interfaces | `GET .../wans` → nur `id`, `name` (kein Status, keine IP, kein Durchsatz) | Plugin-Daten | 1 h | [D] |
| WAN-IP (IPv4) | `ipAddress` des Geräts mit Feature `gateway` = öffentliche WAN-IP | `NetworkDevice`/`Service` | mit Geräten | [A backend/app/clients/unifi.py:338-341][D*] |
| WAN-Durchsatz live | Legacy `GET /proxy/network/api/s/{site}/stat/health`, Subsystem `wan`: `rx_bytes-r`/`tx_bytes-r` (Byte/s), `status`, `wan_ip`, `gw_system-stats` | `Metric` | 30 s / 120 s | [D*] (unpoller-Fixture) |
| WAN-Durchsatz (Kandidat ohne Legacy) | `statistics/latest` des Gateways: `uplink.rxRateBps/txRateBps`, Bedeutung beim Gateway (= WAN?) | `Metric` | 30 s / 300 s | [?] |
| ISP-Name, Speedtest | Legacy `stat/health`: `wan.isp_name`, `wan.isp_organization`; `www.xput_down/xput_up`, `speedtest_lastrun`, `latency` | `Service` | 300 s / 900 s | [D*] |
| ISP-Metriken | Cloud `GET /v1/isp-metrics/5m?duration=24h` oder `POST /v1/isp-metrics/5m/query` `{sites:[{hostId, siteId}]}` → `wan.avgLatency`, `maxLatency`, `packetLoss`, `uptime`, `downtime`, `download_kbps`, `upload_kbps`, `ispName`, `ispAsn` | `Metric` | 5 min / 15 min | [D] |
| Konsolen-Erreichbarkeit (Cloud) | `GET /v1/hosts` → `id`, `type`, `ipAddress`, `isBlocked`, `lastConnectionStateChange`, `latestBackupTime`, `reportedState` | `Host` | 15 min | [D] |
| Firmware-Status (Cloud) | `GET /v1/devices` → `status`, `version`, `firmwareStatus`, `updateAvailable` | `NetworkDevice` (Abgleich per MAC) | 1 h | [D] |

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| AP/Switch neu starten | `POST /v1/sites/{siteId}/devices/{deviceId}/actions` `{"action":"RESTART"}` | medium | operator | keins (Key ist voll) | [D] |
| Gateway neu starten | wie oben, Gerät mit Feature `gateway` | high (Internet + Cloudflare-Tunnel weg) | admin | keins | [D] |
| PoE-Port power-cyclen | `POST .../devices/{deviceId}/interfaces/ports/{portIdx}/actions` `{"action":"POWER_CYCLE"}` | high (Default: Port speist oft AP/Switch); medium nur, wenn am Port kein Infrastrukturgerät hängt [?] | admin (high) | keins | [D] |
| (später) Gast-Client freischalten | `POST .../clients/{clientId}/actions` `AUTHORIZE_GUEST_ACCESS`/`UNAUTHORIZE_GUEST_ACCESS` | low | operator | keins | [D] |

Audit-Text-Vorschlag: „{user} hat {device.name} ({model}, {mac}) neu gestartet“ bzw. „… Port {idx} an {device.name} per PoE neu gestartet“.

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| WAN | S: Status + WAN-IP; M: + Live-Durchsatz-Sparkline; L: + ISP, Latenz/Paketverlust (ISM), letzter Speedtest | S/M/L |
| Clients | S: Gesamtzahl; M: kabelgebunden/WLAN; L: Balken pro AP mit Trend | S/M/L |
| Geräte-Health | M: Liste Zustand + Firmware-Update-Badge; L/XL: + CPU/RAM/Uptime, Ports belegt/gesamt, PoE | M/L/XL |

### Seiten (Vorschlag)

- **Netzwerk › Geräte:** Tabelle (Zustand, Modell, Firmware, Uptime, CPU/RAM). Detail mit Ports, PoE und Funk, Aktionen-Menü (nur wenn freigeschaltet).
- **Netzwerk › Clients:** Tabelle (Name, IP, Typ, verbunden seit, Uplink-Gerät), Filter nach AP.
- **Netzwerk › WAN:** Durchsatz-Verlauf, ISP-Metriken (24 h aus 5m-Serie, 30 d aus 1h-Serie [D]).
- **Topologie** (später): Baum aus `uplink.deviceId` [D].

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Gateway offline | `state != ONLINE` beim Gateway > 2 min oder Konsole nicht erreichbar | crit |
| AP/Switch offline | `state` ∈ {OFFLINE, CONNECTION_INTERRUPTED} > 5 min | warn |
| WAN gestört | Legacy `wan.status != ok` oder ISM `downtime > 0` im letzten 5-min-Fenster | crit |
| Paketverlust | ISM `packetLoss > 2` über 15 min | warn |
| Latenz hoch | ISM `avgLatency` > 3 × 7-Tage-Median | warn |
| Firmware-Update verfügbar | `firmwareUpdatable = true` > 7 Tage | info |
| Gerät überlastet | `cpuUtilizationPct > 90` oder `memoryUtilizationPct > 90` über 10 min | warn |
| AP ohne Clients | Clients pro AP fällt auf 0 bei sonst > 3 (Tageszeit-unabhängig > 30 min) | warn |
| Key ungültig | lokaler Test liefert 401 | crit (Plugin-Health) |

## Rate-Limits & Last

- **Lokal:** keine Rate-Limits dokumentiert [?]. Last pro Zyklus: `/devices` + `/clients` (je ⌈n/limit⌉ Seiten) + `statistics/latest` × Gerätezahl + optional ein Legacy-`stat/health`. Für einen Haushalt (≤ 10 Geräte, < 100 Clients) unkritisch.
- **Device care:** Der Detail-Endpunkt wird selten abgefragt (Topologie ändert sich kaum). `statistics/latest` und `stat/health` laufen nur bei aktivem Widget im schnellen Takt. Identische Abfragen bündeln (Widget, Metrik-Sampler und Seite teilen einen Cache). Altapp-Fehler vermeiden: Der Metrik-Loop umgeht den Cache und verdoppelt die Last [A backend/app/main.py:219-234 vs. backend/app/routers/network.py:58].
- **Site Manager:** v1 (stabil) 10.000 Anfragen/min, EA 100/min [S]. Bei 429 kommt Header `Retry-After` und eine Meldung wie „rate limit exceeded, retry after 5.37s“ [D]. ISM-Daten sind 5-Minuten-Buckets, schneller als alle 5 min zu pollen bringt nichts [D].
- Timeouts: lokal 8 s (Altapp-Wert [A backend/app/clients/unifi.py:636]), Cloud 10 s; Circuit Breaker nach 3 Fehlschlägen, Backoff bis 10 min.

## Verbindungstest & Fehlercodes

Ablauf: TCP/TLS → Fingerabdruck → `GET /v1/info` → `GET /v1/sites` (Site auflösen) → `GET .../devices?limit=1` → optional Legacy `stat/health` → optional Cloud `GET /v1/hosts`.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | DNS-Fehler, ECONNREFUSED, Timeout | „UniFi-Konsole unter {host}:{port} nicht erreichbar.“ |
| `TLS_UNTRUSTED` | erster Kontakt, kein Pin | „Zertifikat unbekannt. Fingerabdruck {sha256} mit der Konsole vergleichen und vertrauen.“ |
| `TLS_PIN_MISMATCH` | SPKI ≠ gespeicherter Pin | „Das Zertifikat der Konsole hat sich geändert. Nur bestätigen, wenn du es erwartet hast (Reset/Update).“ |
| `API_NOT_AVAILABLE` | 404 auf `/proxy/network/integration/v1/info` | „Integration API nicht gefunden. UniFi Network ≥ 9.0 auf einer UniFi-OS-Konsole nötig.“ |
| `AUTH_INVALID` | 401 lokal | „API-Key ungültig oder widerrufen. Ein Key von unifi.ui.com funktioniert lokal nicht.“ |
| `AUTH_FORBIDDEN` | 403 lokal | „Key hat keinen Zugriff. Rolle des Admins prüfen, der ihn erstellt hat.“ |
| `SITE_NOT_FOUND` | Site nicht in `/v1/sites` | „Site ‚{site}‘ nicht gefunden. Verfügbar: {liste}.“ |
| `LEGACY_STATS_UNAVAILABLE` | 401/404 auf `stat/health` | Warnung: „WAN-Durchsatz/ISP nicht verfügbar (Legacy-Endpunkt verweigert). Rest funktioniert.“ |
| `SM_AUTH_INVALID` | 401 von api.ui.com | „Site-Manager-Key ungültig.“ |
| `SM_RATE_LIMITED` | 429 | „Cloud-Ratenlimit erreicht, nächster Versuch in {Retry-After} s.“ |
| `SM_NO_HOST` | `/v1/hosts` leer oder Host-ID fehlt | „Im UI-Konto ist keine (passende) Konsole sichtbar.“ |

## Eigenheiten & Stolperfallen

- **IDs:** Die Integration API nutzt Site-UUIDs, Legacy nutzt `internalReference` (z. B. `default`) [D][D*]. Geräte-IDs sind UUIDs ohne Legacy-Pendant. Der einzige stabile Schlüssel über alle drei APIs ist die MAC (Altcode-Kommentar [A backend/app/models.py:144-146]).
- **Gateway-`ipAddress` ist die WAN-IP**, nicht die LAN-IP [A][D*]. Die Erkennung erfolgt über `features` = `gateway` [D], nicht über Modellnamen (Altcode [A backend/app/clients/unifi.py:220-234]).
- **CPU/RAM stehen nicht im Geräte-Detail**, sondern in `.../statistics/latest` [D]. Der Altcode liest `statistics` aus dem Detail-Objekt [A backend/app/clients/unifi.py:153-217], die Werte fehlen also über die Integration API wohl immer und kommen nur über die Cookie-Anreicherung.
- **WAN-Daten** liefert die Integration API kaum (`/wans` nur `id`/`name` [D]). Durchsatz, ISP und WAN-Status kommen vorerst aus Legacy `stat/health` oder Site Manager.
- **Legacy-Feldnamen:** `rx_bytes-r`/`tx_bytes-r` mit Unterstrich; `xput_down/xput_up` liegen im Subsystem `www`, nicht in `wan` [D*].
- **ISP-Metriken:** `GET /v1/isp-metrics/{type}` kennt nur `beginTimestamp`/`endTimestamp`/`duration`, keinen `siteId`-Filter. Für eine Site gibt es `POST .../query`. Fehlt der Zugriff auf alle Sites, antwortet `/query` mit 502, bei Teilzugriff mit `status: partialSuccess` [D]. Früher lag der Endpunkt unter `/ea/isp-metrics/...`; EA-Pfade bleiben nach der Beförderung funktionsfähig [S].
- ISM-Werte: `-1` als „kein Messwert“ beobachtet [A backend/tests/test_unifi_remote.py:266-302]. `download_kbps` ist eher Speedtest-/Kapazitätswert als Live-Traffic [A backend/app/routers/network.py:34-40][?].
- Spec-Abweichungen: Der Spiegel nennt kleinere Abweichungen von OpenAPI 3.1 in Ubiquitis Specs [D]. Deshalb tolerant parsen (Zod `passthrough`, optionale Felder).
- **Selbst-Aussperren:** Gateway-Neustart oder Power-Cycle des Uplinks zum Proxmox-Host trennt den Cloudflare-Tunnel, das Dashboard ist dann nicht erreichbar. Der Bestätigungsdialog muss das sagen.
- Clients: VLAN-Zugehörigkeit pro Client gibt die Integration API nicht her (Stand 10.3) [A backend/app/clients/unifi.py:291-293]; in 10.6 nicht nachgeprüft [?].

## Wissen aus dem Altcode

- ENV-Variablen für die Migration: `UNIFI_HOST`, `UNIFI_PORT`, `UNIFI_API_KEY`, `UNIFI_USERNAME`, `UNIFI_PASSWORD`, `UNIFI_SITE`, `UNIFI_VERIFY_TLS`, `UNIFI_SITE_MANAGER_API_KEY`, `UNIFI_SITE_MANAGER_HOST_ID`, `CACHE_TTL_UNIFI=30` [A backend/app/config.py:77-99, 131; infrastructure/.env.example:80-106]. Benutzername und Passwort werden **nicht** übernommen (Cookie-Auth entfällt).
- Ablauf heute: Integration API → bei Erfolg Legacy-Anreicherung (`stat/device`, `stat/health`) per Cookie → sonst reiner Legacy-Fallback (`stat/health`, `stat/sta`, `rest/networkconf`) [A backend/app/clients/unifi.py:440-505, 508-622, 625-651].
- **Bug:** Der Altcode liest `rx-bytes-r`/`tx-bytes-r` mit Bindestrich und `xput_*` aus `wan` [A backend/app/clients/unifi.py:468-471, 541-552]. Laut unpoller-Fixture heißen die Felder `rx_bytes-r` und liegen im Subsystem `www` [D*]. Live-Durchsatz und Linkspeed waren daher vermutlich immer 0 bzw. leer.
- **Bug:** `/isp-metrics/5m?siteId=…` und `/sites?hostId=…` nutzen undokumentierte Parameter [A backend/app/clients/unifi_remote.py:251-270]. `nextToken`-Paging fehlt.
- Paging der Integration API mit `offset`/`limit=200`, maximal 25 Seiten [A backend/app/clients/unifi.py:90-124]. Das Plugin übernimmt die Idee, aber mit `totalCount`.
- Speedtest-Werte (ISM) und Live-Durchsatz nicht vermischen [A backend/app/routers/network.py:34-40].
- GeoIP-Fallback für den ISP-Namen über ipapi.co [A backend/app/routers/network.py:42-52; backend/app/clients/geoip.py:24]: Das ist ein externer Dienst außerhalb des Plugin-Hosts (SSRF-/Datenschutz-Thema). Im Plugin entfällt er, der ISP kommt aus `stat/health` oder ISM.
- Die Altapp hat keine Aktionen.

## Testbarkeit (Vertragstests)

- **Offizielle OpenAPI 3.1** je Network-Version (in der App unter Integrations und auf developer.ui.com) und für Site Manager v1.0.0 [D]. Typen per `openapi-typescript` aus der gepinnten Version erzeugen (10.3.58 = Owner-Stand), Zod-Schemas tolerant halten.
- **Fixtures aus dem Altcode:** reale Shapes von 10.3.58 für `sites`, `networks`, `clients`, `devices` [A backend/tests/test_unifi.py:48-100]. ISM-Shapes inkl. `-1`-Sentinel, leere Perioden und flaches Layout [A backend/tests/test_unifi_remote.py]. Die Fixture für Geräte-Detail mit `statistics` [A backend/tests/test_unifi.py:192-202] widerspricht der Spec und wird **nicht** übernommen.
- Legacy-`stat/health`-Fixture: `unpoller/unifi/endpoints_data/stat-health.json` [D*].
- Neu aufzunehmen (einmalig gegen die echte Konsole, anonymisiert): `/v1/info`, `statistics/latest` von Gateway und AP, `/wans`, Aktionsantworten (`RESTART`, `POWER_CYCLE`) sowie Fehlerantworten 401/404.

## Aufwand & Empfehlung

- **Aufwand M:** Die API ist sauber spezifiziert, Auth ist ein Header, Altwissen und Fixtures sind vorhanden. Mehraufwand entsteht durch drei API-Flächen (lokal, Legacy-Stats, Cloud), MAC-basiertes Zusammenführen, Pinning und die zwei Aktionen mit Risiko-Eskalation.
- Abhängigkeiten: SDK (configSchema, Secrets, TLS-Pinning im HTTP-Client, Aktionsvertrag mit Re-Auth), `openapi-typescript` (dev).
- **Welle 1** (bestehende Integration, Owner nutzt sie täglich).

## Offene Punkte

1. Kann ein Admin mit Rolle „View Only“ einen lokalen Key erzeugen, und ist dieser dann schreibgeschützt? Test auf der UCG Ultra.
2. Funktioniert `X-API-KEY` auf Legacy `stat/health` bei Network 10.3.58 des Owners? (Belege nur [D*].)
3. Liefert `statistics/latest` des Gateways in `uplink.rxRateBps/txRateBps` den WAN-Durchsatz? Dann könnte Legacy ganz entfallen.
4. Maximaler `limit`-Wert der Integration API, lokale Rate-Limits.
5. Bleibt der SPKI des Konsolen-Zertifikats bei Firmware-Updates stabil?
6. Owner-Entscheid: Ist PoE-Power-Cycle immer `high`, oder `medium` für Ports ohne Infrastrukturgerät?

## Quellen

1. https://github.com/opastorello/unifi-api-docs (`network/v10.6.106/reference.md`, `openapi.json`; `v10.3.58`, `v10.0.162`, `v9.1.120`; `site-manager/v1.0.0/reference.md`, `openapi.json`): automatischer Spiegel von developer.ui.com. Bestätigt Endpunkte, Felder, Aktionen `RESTART`/`POWER_CYCLE`, Paging, ISM-Felder und Retention, 429/`Retry-After`, Remote-Connector-Basis-URL.
2. https://developer.ui.com/site-manager-api/gettingstarted, https://developer.ui.com/unifi-api/gettingstarted [S]: Rate-Limits 10.000/min (v1) bzw. 100/min (EA), Key „currently read-only“, `/ea/`- vs. `/v1/`-Pfade.
3. https://help.ui.com/hc/en-us/articles/30076656117655 [S]: Getting Started with the Official UniFi API, Integrations-Menü.
4. https://github.com/Art-of-WiFi/UniFi-API-client (README, `src/Client.php`) [D*]: `X-API-KEY` auf Legacy-Pfaden unter `/proxy/network`, Key erbt Admin-Rechte und wird nur einmal angezeigt, Connector ≥ 5.0.3 / ~800 ms, Legacy-`cmd/devmgr` (`restart`, `power-cycle`).
5. https://github.com/baileywickham/unifi-cli/blob/main/docs/api-notes.md [D*]: Integrations-URL in 10.x, Cloud-Key lokal 401, Gateway-`ipAddress` = WAN-IP, selbstsigniertes Zertifikat, `id.ui.direct`.
6. https://github.com/home-assistant/home-assistant.io/issues/40330 [D*]: Key-Erstellung nur Super Admin/Owner, Keys an Benutzer gebunden.
7. https://github.com/unpoller/unifi (`site.go`, `endpoints_data/stat-health.json`) [D*]: Feldnamen `rx_bytes-r`, `isp_name`, `xput_*` im Subsystem `www`.
8. Release-Notes-Spiegel Network 9.0.92 (ubiquiti-networks-forum.de) [S]: Einführung Network Application API, UniFi OS ≥ 4.1.9.
9. Altcode: `backend/app/clients/unifi.py`, `backend/app/clients/unifi_remote.py`, `backend/app/routers/network.py`, `backend/app/config.py`, `backend/app/models.py`, `backend/app/main.py`, `backend/tests/test_unifi.py`, `backend/tests/test_unifi_remote.py`, `docs/SETUP.md` (2.4a/2.4b), `infrastructure/.env.example` [A].
