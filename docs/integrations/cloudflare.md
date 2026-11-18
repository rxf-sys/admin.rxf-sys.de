# Cloudflare (`cloudflare`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick

- Kategorie: **DNS/Edge**
- Zweck: Das Plugin zeigt Zustand und Last der Cloudflare-Kante: Tunnel und Connectors, DNS-Records, Zonen-Traffic (Requests, Cache, Threats), Edge-Zertifikate. Als einzige Aktion gibt es Cache leeren (Purge).
- Reine Cloud-API: `https://api.cloudflare.com/client/v4` (REST, JSON-Envelope `success`/`errors`/`result`/`result_info`) und `POST /client/v4/graphql` für Analytics [D][A `backend/app/clients/cloudflare.py:13`]. Es gibt keine lokale API. `cloudflared` selbst wird nicht abgefragt.
- Versionen: Die API ist unversioniert (v4). Für den Plugin-Entwurf zählen nur die Deprecations bis heute:
  - Zone Analytics REST (`/zones/:id/analytics/dashboard`, `/analytics/colos`) ist seit 01.03.2021 deprecated, Ersatz ist die GraphQL Analytics API [D].
  - Das Feld `connections` in den `cfd_tunnel`-List-/Get-Antworten ist seit 05.10.2026 entfernt. Verbindungen gibt es nur noch über `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` [D].
  - Die Argo-Tunnel-API `accounts/:id/tunnels` ist seit 04.02.2024 deprecated [D].

## Verbindung & Auth

- Auth: API-Token als `Authorization: Bearer <token>` [D][A `cloudflare.py:24`]. Den Global API Key unterstützt das Plugin bewusst nicht.
- Token-Typen:
  - **User-Token** (My Profile › API Tokens): Prüfung über `GET /user/tokens/verify` [D].
  - **Account-owned Token** (Manage Account › API Tokens): Prüfung über `GET /accounts/{account_id}/tokens/verify` [D]. Es überlebt das Ausscheiden des Erstellers und wird für Dauerintegrationen empfohlen [D]. Inkompatibel ist es nur mit Intel, Page Rules, Registrar, Super Bot Fight Mode, Turnstile und Zero Trust Client Platform. Keines davon braucht dieses Plugin [D].
  - Beide Verify-Endpunkte liefern `status` (`active`/`disabled`/`expired`), `expires_on` und `not_before` [D].
- Neue User-Token tragen das Präfix `cfut_`. Das gehört in die Log-Redaction-Regex [D]. Ein Präfix für Account-Token ist nicht belegt [?].
- Session: keine, Token pro Request. Token-TTL und IP-Filter optional beim Anlegen [D].
- TLS: öffentliche CA. Kein Pinning nötig, Standard-Verifikation. SSRF: Das Plugin spricht ausschließlich `api.cloudflare.com` an (Host fest im Code, nicht konfigurierbar).
- Entwurf `configSchema`:

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `apiToken` | string | ja | ja | Lese-Token mit den Rechten aus „Nur lesen“. Wird nie an den Browser zurückgegeben. |
| `accountId` | string (32 hex) | ja | nein | Account-ID (Dashboard › Account-Übersicht). Kann aus `GET /zones/{id}` → `account.id` vorbelegt werden [D]. |
| `zoneIds` | string[] | ja (≥1) | nein | Überwachte Zonen. Auswahl per `GET /zones` (braucht `Zone Read`) [S]. |
| `tunnelIds` | string[] | nein | nein | Leer heißt: alle nicht gelöschten Tunnel des Accounts (`is_deleted=false`) [D]. |
| `actionToken` | string | nein | ja | Optionales separates Token nur mit `Cache Purge`. Leer: `apiToken` wird genutzt, sobald Aktionen aktiv sind. |
| `analyticsWindowMin` | int 5–1440 | nein | nein | Zeitfenster der Traffic-Kachel, Standard 60 [A `routers/cloudflare.py:49`]. |
| `certWarnDays` | int | nein | nein | Vorwarnzeit Edge-Zertifikate, Standard 14 [A `config.py:160`]. |
| `expectTunnelCnames` | bool | nein | nein | CNAMEs auf `*.cfargotunnel.com` gegen bekannte Tunnel-IDs prüfen (Standard an) [A `cloudflare.py:424-437`]. |

## Minimale Rechte

### Nur lesen

| Typ | Recht (exakter Name) | Ressource | Wofür | Quelle |
|---|---|---|---|---|
| Account | `Cloudflare Tunnel Read` | Account | Tunnel, Connections, Connectors, Tunnel-Konfiguration | [D] Name; [S] Endpunkt-Zuordnung |
| Zone | `Zone Read` | gewählte Zonen | Zonenliste, Zonenname, `account.id` | [D] Name; [S] `GET /zones` |
| Zone | `DNS Read` | gewählte Zonen | `GET /zones/{id}/dns_records` | [D] Name; [S] Zuordnung |
| Zone | `Analytics Read` | gewählte Zonen | GraphQL `httpRequestsAdaptiveGroups` u. a. | [D] (GraphQL-403 nennt „Analytics: Read“); [A `docs/SETUP.md` 2.3] |
| Zone | `SSL and Certificates Read` | gewählte Zonen | `GET /zones/{id}/ssl/certificate_packs` | [D] Name; [S] „at least one: SSL and Certificates Read/Write“ |

- Alternativen zu `Cloudflare Tunnel Read` laut API-Referenz: `Cloudflare One Connector: cloudflared Read` und `Cloudflare One Connectors Read` (jeweils „at least one required“) [D] Namen; [S] Zuordnung. Im Onboarding bleibt der klassische Name.
- Account- und Zonenrechte dürfen in **einem** Custom Token stehen [D]. Die Unterscheidung „Account-Ebene“ (Tunnel, später ggf. Access-Logs) gegenüber „Zonen-Ebene“ (DNS, SSL, Analytics, Purge) bestimmt nur die Ressourcen-Auswahl im Token-Dialog.
- Nicht nötig (bewusst weggelassen): `Account Settings Read`, `Account Analytics Read` (nur Account-Datasets), `Zone Settings Read`, `Firewall Services Read`, `Logs Read`.
- Optional, nicht im MVP: `Access: Audit Logs Read` (Account) für die Access-Login-Historie [D] Name; [S] Endpunkt `access/logs/access_requests`.

### Zusätzlich für Aktionen

| Typ | Recht | Ressource | Aktion | Quelle |
|---|---|---|---|---|
| Zone | `Cache Purge` („Grants access to purge cache.“) | gewählte Zonen | alle Purge-Varianten | [D] |

Empfehlung: Das Purge-Recht steckt in einem zweiten Token (`actionToken`). Das Lese-Token bleibt so rein lesend, und der Admin kann die Aktionen abschalten, indem er nur das zweite Token widerruft.

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

1. Zone-ID und Account-ID notieren (Zonen-Übersicht, rechte Seitenleiste). [Screenshot: Zonen-Übersicht mit API-Box] – Doku: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/
2. Token-Art wählen: Account-owned Token unter **Manage Account › API Tokens** (empfohlen) oder User-Token unter **My Profile › API Tokens** [D]. [Screenshot: API-Tokens-Seite]
3. **Create Token** → eigenes (Custom) Token statt Vorlage [D]. Name z. B. `rxf-admin-read`.
4. Rechte setzen [Screenshot: Permissions-Tabelle]:
   - `Account` · `Cloudflare Tunnel` · `Read`
   - `Zone` · `Zone` · `Read`
   - `Zone` · `DNS` · `Read`
   - `Zone` · `Analytics` · `Read`
   - `Zone` · `SSL and Certificates` · `Read`
5. Ressourcen eingrenzen: nur den eigenen Account und nur die gewünschten Zonen (z. B. `rxf-sys.de`) [D]. [Screenshot: Zone Resources]
6. Optional **Client IP Address Filtering** (öffentliche WAN-IP des Dashboards) und **TTL** setzen [D]. Hinweis im UI: Ein IP-Filter führt bei IP-Wechsel zum Fehler `CF_IP_RESTRICTED`.
7. **Continue to summary** → **Create Token** → Secret kopieren. Es wird nur einmal angezeigt [D].
8. Nur wenn Aktionen gewünscht sind: zweites Token `rxf-admin-purge` mit `Zone` · `Cache Purge` · `Purge` [D] Recht; [S] Stufenbezeichnung „Purge“, gleiche Zonen.
9. Im Formular einfügen → „Verbindung testen“. Ablauf des Tests: Verify, dann je Recht ein Lese-Request (siehe unten).
   Doku: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Token-Status, Ablauf | `GET /user/tokens/verify` bzw. `GET /accounts/{account_id}/tokens/verify` | – (Plugin-Health) | bei Test + 24 h / 24 h | [D] |
| Tunnel-Liste + Status (`inactive`/`degraded`/`healthy`/`down`), `conns_active_at`, `conns_inactive_at`, `config_src`, `tun_type` | `GET /accounts/{account_id}/cfd_tunnel?is_deleted=false` (paginiert) | `Service` (kind `tunnel`) + Plugin-Daten | 30 s / 120 s | [D]; [A `cloudflare.py:100-153`] |
| Connectors je Tunnel: `id`, `version`, `arch`, `run_at`, `conns[]` (`colo_name`, `opened_at`, `origin_ip`, `client_id`, `client_version`) | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` | Plugin-Entität `connector` (→ `Host` über `origin_ip` verknüpfbar) | 30 s / 120 s | [D]; [A `cloudflare.py:113-144`] |
| Einzelner Connector | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connectors/{connector_id}` | wie oben | nur Detailseite | [D] |
| Public Hostnames (Ingress) remote verwalteter Tunnel | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` → `config.ingress[].hostname/service` | `Endpoint` (Vorschlag für Uptime-Checks) | 15 min / 60 min | [D] |
| Zonen (Name, Status, `account.id`) | `GET /zones` / `GET /zones/{zone_id}` | Plugin-Entität `zone` | 60 min / 6 h | [D] Felder; [S] Recht |
| DNS-Records (alle Typen, `proxied`) | `GET /zones/{zone_id}/dns_records?page=&per_page=` | Plugin-Entität `dnsRecord`, Tunnel-CNAMEs → `Endpoint` | 10 min / 60 min | [D] Pfad; [A `cloudflare.py:406-451`]; per_page-Maximum [?] |
| Edge-Zertifikate: Pack-`status`, `type`, `certificate_authority`, `validity_days`, `validation_errors`, `certificates[].expires_on/hosts/issuer/status` | `GET /zones/{zone_id}/ssl/certificate_packs?status=all` (per_page 5–50) | `Certificate` | 60 min / 6 h | [D] Felder; [S] per_page; [A `cloudflare.py:166-206`] |
| Traffic: Requests, Bytes, Cache-Status je Minute | `POST /graphql`, `viewer.zones(filter:{zoneTag_in})` → `httpRequestsAdaptiveGroups { count sum { edgeResponseBytes } dimensions { datetimeMinute cacheStatus } }` | `Metric` | 5 min / 15 min | [A `cloudflare.py:226-333`]; [D] GraphQL-Limits |
| Threats / Security-Events | GraphQL `firewallEventsAdaptive` (Rohereignisse, clientseitig zählen) | `Metric` | 5 min / 15 min | [S] „essential datasets für alle Pläne“; Free-Verhalten [?] (Altcode: „auf Free meist leer“ [A `cloudflare.py:238-239`]) |
| Dataset-Grenzen des Plans (`enabled`, `maxDuration`, `notOlderThan`, `maxPageSize`) | GraphQL `viewer.zones { settings { <dataset> { … } } }` | – (Plugin-Capabilities) | bei Test + 24 h | [D] |

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| `purge.urls` – einzelne URLs leeren (max. 100 je Request auf Free–Business) | `POST /zones/{zone_id}/purge_cache` `{"files":[…]}` | low | operator | `Cache Purge` | [D] |
| `purge.hosts` / `purge.prefixes` / `purge.tags` | dito mit `hosts` / `prefixes` / `tags` (auf allen Plänen verfügbar) | low | operator | `Cache Purge` | [D] |
| `purge.everything` – ganze Zone leeren (Bestätigungsdialog, Audit-Text „Cache der Zone {zone} vollständig geleert“) | dito `{"purge_everything":true}` (einziges Feld) | low | operator | `Cache Purge` | [D] |

- HTTP 200 mit `success:true` heißt nur „angenommen“, nicht „Inhalt war im Cache“ [D]. Prüfen lässt sich ein Purge über `CF-Cache-Status: MISS` auf der URL [D]. Das UI zeigt deshalb „Purge angenommen“.
- Nicht im MVP, nur als Ausblick: Connector-Verbindung entfernen (`DELETE …/cfd_tunnel/{id}/connections?client_id=`, braucht `Cloudflare Tunnel Edit/Write`, Risiko medium) [D] Pfad. DNS-Änderungen bleiben außen vor.

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| Tunnel-Status | Ampel je Tunnel, Anzahl Connectors/Verbindungen, Colos (z. B. `fra06`), cloudflared-Version | S, M |
| Traffic | Requests/min als Sparkline, Cache-Hit-%, Bandbreite; ab L Threats und Zeitreihe 24 h | M, L, XL |
| Edge-Zertifikate | kürzeste Restlaufzeit, Packs ≠ `active` | S, M |
| DNS-Konsistenz | Tunnel-CNAMEs mit falscher/unbekannter Tunnel-ID, Anzahl Records je Typ | M, L |

### Seiten (Vorschlag)

- **Cloudflare › Übersicht**: Kacheln wie oben, Token-Ablauf, letzter Abruf.
- **Tunnels**: Tabelle Tunnel → Connectors (Version, Arch, `run_at`, `origin_ip`, Colos), Ingress-Hostnames mit Link „Uptime-Check anlegen“.
- **DNS**: filterbare Record-Tabelle (Typ, Name, Inhalt, proxied), Tunnel-CNAMEs zuerst [A `cloudflare.py:446-450`].
- **Traffic**: Zeitreihen Requests/Cache/Bytes/Threats, Zeitfenster bis `maxDuration` des Plans.
- **Zertifikate**: Packs mit Status, CA, Ablauf, Validierungsfehlern.
- **Aktionen** (nur sichtbar, wenn freigeschaltet): Purge-Dialog mit Variantenwahl.

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Tunnel down | `status = down` ≥ 2 Polls (Altcode: sofort) [A `notify.py:242-261`] | crit |
| Tunnel degraded | `status = degraded` ≥ 2 min | warn |
| Redundanz verloren | Anzahl Connectors oder Verbindungen < konfiguriertes Minimum (z. B. 2) | warn |
| Edge-Zertifikat läuft ab | `expires_on` ≤ `certWarnDays` (14) bzw. ≤ 7 Tage [A `notify.py:224-240`] | warn / crit |
| Zertifikats-Pack gestört | Pack-`status` ∉ {`active`} oder `validation_errors` nicht leer | warn |
| Tunnel-CNAME falsch | CNAME auf `*.cfargotunnel.com` mit unbekannter Tunnel-ID [A `cloudflare.py:433-437`] | warn |
| Token läuft ab | `expires_on` ≤ 14 Tage oder `status ≠ active` | warn / crit |
| Plugin-API-Fehler | 3 Polls in Folge nicht erreichbar → Plugin-Status `unknown`, **kein** Tunnel-Alarm | warn |

## Rate-Limits & Last

| Grenze | Wert | Quelle |
|---|---|---|
| Client API je User/Account-Token | 1.200 Requests / 5 min, kumulativ über Dashboard, API Keys und Tokens; bei Überschreitung 5 min lang alle Calls HTTP 429 | [D] |
| Client API je IP | 200 Requests / s | [D] |
| GraphQL | „max 320 / 5 min, je nach Query-Kosten“ (API-Limits-Seite) bzw. „300 GraphQL queries over 5-minute window“ (GraphQL-Limits-Seite). Für die Planung gilt **300**. | [D] (widersprüchlich) |
| GraphQL-Zählweise | Queries je Request = Zonen/Accounts × Nodes. Max. 10 Zonen je zonenbezogener Query, 1 Account je Account-Query | [D] |
| GraphQL-Dataset | Adaptive Datasets: ≥ 31 Tage Historie auf allen Plänen. `maxDuration`/`maxPageSize` je Plan über den `settings`-Node | [D] |
| Purge Free (hosts/tags/prefixes/everything) | 5 Requests/min, Bucket 25, 100 Operationen/Request | [D] |
| Purge Free (single file) | 800 URLs/s (gleitender Mittelwert), 100 URLs/Request | [D] |
| Header | `Ratelimit` (`r` Rest, `t` Reset), `Ratelimit-Policy`, `retry-after` nur bei Überschreitung | [D] |

Budget-Rechnung (1 Account, 1 Zone, 1 Tunnel, jemand schaut zu): Tunnel 2 Calls je 30 s ergibt 20 je 5 min. Dazu kommen DNS ca. 0,5, Zertifikate ca. 0,1 und GraphQL 1 (bei 300er-Grenze). Zusammen sind das ca. 22 von 1.200, also unter 2 %. Im Hintergrund sinkt der Wert auf unter 1 %. Weil das Limit pro User kumulativ ist (auch Terraform, Dashboard-Klicks), wertet der Collector `Ratelimit` aus und halbiert die Frequenz, sobald `r` unter 20 % fällt. Bei 429 setzt der Circuit-Breaker für `retry-after` Sekunden aus. Der Altcode deckelte `Retry-After` auf 5 s [A `cloudflare.py:54-56`]. Das ist zu kurz, weil eine Überschreitung die API 5 min sperrt.

Der Altcode fragt Tunnel und Zertifikate zusätzlich aus der Notification-Schleife alle 60 s **am Cache vorbei** ab [A `backend/app/main.py:68-72`]. In v2 lesen Alarme nur aus dem Collector-Snapshot.

## Verbindungstest & Fehlercodes

Ablauf von `test()`:

1. Verify, zuerst User-, dann Account-Endpunkt.
2. `GET /zones/{id}` je Zone.
3. `GET …/cfd_tunnel?per_page=1`.
4. `GET …/dns_records?per_page=1`.
5. `GET …/ssl/certificate_packs`.
6. GraphQL-`settings`-Query für `httpRequestsAdaptiveGroups` und `firewallEventsAdaptive`.

Jedes Recht wird einzeln gemeldet, Teil-Erfolg ist möglich. Das Purge-Recht lässt sich nicht nebenwirkungsfrei prüfen [?]. Es wird erst beim ersten Purge gemeldet.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `CF_UNREACHABLE` | DNS-/TCP-/TLS-Fehler, Timeout zu `api.cloudflare.com` | „Cloudflare-API nicht erreichbar – Internetzugang, DNS oder Proxy des Servers prüfen.“ |
| `CF_AUTH_INVALID` | HTTP 401/400 auf Verify, `errors[].code` 10000 „Authentication error“ [S] | „Token ungültig – bitte neu kopieren (es wird nur einmal angezeigt).“ |
| `CF_TOKEN_INACTIVE` | Verify `status` = `disabled`/`expired` [D] | „Token ist deaktiviert oder abgelaufen (gültig bis {expires_on}).“ |
| `CF_IP_RESTRICTED` | `errors[].code` 9109 „Cannot use the access token from location“ [S] | „Token ist per IP-Filter gesperrt – IP-Filter im Token an die aktuelle WAN-IP anpassen.“ |
| `CF_SCOPE_TUNNEL` | 403 auf `cfd_tunnel` | „Token hat kein Recht ‚Account › Cloudflare Tunnel › Read‘ für Account {accountId}.“ |
| `CF_SCOPE_DNS` | 403 auf `dns_records` | „Token hat keine Leserechte auf DNS der Zone {zone}.“ |
| `CF_SCOPE_SSL` | 403 auf `certificate_packs` | „Token fehlt ‚Zone › SSL and Certificates › Read‘ – Zertifikate bleiben leer.“ |
| `CF_SCOPE_ANALYTICS` | GraphQL HTTP 403 oder `errors[].message` „does not have access to the path“, „zones […] are not authorized“ [D] | „Token fehlt ‚Zone › Analytics › Read‘ – Traffic-Kachel deaktiviert.“ |
| `CF_SCOPE_PURGE` | 403 auf `purge_cache` | „Aktion nicht erlaubt: Token fehlt ‚Zone › Cache Purge‘.“ |
| `CF_ZONE_NOT_FOUND` | 404 bzw. `success:false` auf `/zones/{id}` | „Zone-ID unbekannt oder nicht im Token freigegeben.“ |
| `CF_RATE_LIMITED` | HTTP 429, `retry-after` [D] | „Cloudflare-API-Limit erreicht – nächster Versuch in {n} s.“ |
| `CF_GQL_BUDGET` | GraphQL „rate limiter budget depleted, try again after 5 minutes“ (HTTP 429) [D] | „Analytics-Kontingent verbraucht – Traffic wird in 5 min aktualisiert.“ |
| `CF_GQL_PLAN_LIMIT` | GraphQL HTTP 400 „query time range is too large“ / „cannot request data older than“ [D] | „Zeitfenster für den Cloudflare-Plan zu groß – auf {maxDuration} begrenzt.“ |
| `CF_UPSTREAM` | HTTP 5xx, GraphQL 503 „too many queries in progress“ [D] | „Cloudflare meldet eine Störung – wird automatisch erneut versucht.“ |

GraphQL kann **HTTP 200 mit `errors[]`** liefern. Ohne Fehler ist `errors` `null` [D] [A `cloudflare.py:288-290`].

## Eigenheiten & Stolperfallen

- **Tunnel-`inactive`** heißt „nie gelaufen“, **`down`** heißt „keine Verbindung zur Kante“ [D]. Der Altcode setzt beides auf `down` [A `cloudflare.py:133`]. In v2 wird `inactive` zu `paused`/`unknown` statt `crit`.
- **`connections` im Tunnel-Objekt ist weg** (05.10.2026). Nur `/connections` nutzen [D].
- **`is_pending_reconnect`** ist deprecated und immer `false` [D]. Nicht auswerten.
- **cloudflared-Version**: Der Altcode liest `client_version` auf Connector-Ebene [A `cloudflare.py:143`]. Laut SDK-Typ heißt das Feld dort `version`, `client_version` steht nur in `conns[]` [D]. Die Versionsanzeige war daher vermutlich immer leer [?]. Die Testfixture bildet das falsche Format nach [A `backend/tests/test_cloudflare.py:46-47`].
- **WAN-IP**: Der Altcode fragt bei jedem Cache-Miss (30 s) `api.ipify.org` ab [A `cloudflare.py:156-163`, `routers/tunnel.py:21`]. Ersatz ohne Drittanbieter: `conns[].origin_ip` = „public IP address of the host running cloudflared“ [D].
- **Edge-Zertifikate** (Universal SSL) erneuert Cloudflare selbst. Alarme nur auf Ablaufdatum erzeugen Rauschen, aussagekräftiger sind Pack-`status` und `validation_errors`. Ein Pack enthält oft mehrere Zertifikate (z. B. ECDSA + RSA, `backup_issued`). Der Altcode nimmt das Minimum je (Domain, Issuer) [A `cloudflare.py:200-206`] und kann so ein Backup-Zertifikat melden. Nur `certificates[]` mit `status=active` werten. Der Altcode lädt Packs ohne Paginierung [A `cloudflare.py:173`].
- **GraphQL-Gruppenlimit**: Der Altcode fragt bis 1.440 min × Cache-Status mit `limit: 5000` ab [A `cloudflare.py:243-252`]. Bei 24 h und mehreren Cache-Status droht stilles Abschneiden. Besser `datetimeFiveMinutes` oder Stunden für lange Fenster und Limit nach `maxPageSize`.
- **Adaptive Datasets** sind gesampelte Zählwerte [?]. Im UI als „ca.“ kennzeichnen.
- **Zeitstempel** in GraphQL als ISO-8601 UTC mit Sekunden (`datetime_geq`/`datetime_lt`) [A `cloudflare.py:246-247`].
- **Access-Logins**: Endpunkt und Router existieren [A `routers/cloudflare.py:24-36`], das Frontend ruft sie nie auf (`cfAccessSessions` ungenutzt) [A `frontend/src/api/client.ts:205`]. Der Docstring nennt das falsche Recht „Access: Apps and Policies: Read“, richtig ist `Access: Audit Logs Read` [S]. v1 hat Cloudflare Access durch eigene Logins ersetzt [A `docs/SETUP.md` §3], deshalb nicht ins MVP.
- **Fest verdrahtete Account-ID** als Default [A `backend/app/config.py:71`]. In v2 Pflichtfeld ohne Default.
- **Rechte-Umbenennung**: Cloudflare führt parallel `Cloudflare One Connector: cloudflared Read`. Beide Namen werden vom Tunnel-Endpunkt akzeptiert [S]. Die Onboarding-Texte nennen beide.

## Wissen aus dem Altcode

| Thema | Altcode | Übernahme in v2 |
|---|---|---|
| Retry/Backoff | 3 Versuche bei 429/5xx, 0,5 s → 1 s, `Retry-After` max. 5 s [A `cloudflare.py:28-66`] | SDK-Backoff + Circuit-Breaker, `retry-after` voll respektieren |
| Paginierung | `result_info.total_pages`, `per_page=100`, Notbremse 50 Seiten [A `cloudflare.py:74-97`] | übernehmen, für alle Listen |
| Tunnel | nur **ein** Tunnel (`CF_TUNNEL_ID`) [A `cloudflare.py:100-104`] | alle Tunnel des Accounts oder Auswahl |
| Zonen | nur **eine** Zone (`CF_ZONE_ID`) [A `config.py:72`] | mehrere Zonen, GraphQL bis 10 Zonen je Query [D] |
| DNS-Check | alle Records, `ok=false` nur für Tunnel-CNAMEs ≠ `<tunnel_id>.cfargotunnel.com` [A `cloudflare.py:406-451`] | gegen **alle** bekannten Tunnel-IDs prüfen |
| Analytics | GraphQL `httpRequestsAdaptiveGroups`, Cache-Hit = `hit`/`stale`/`revalidated`/`updating` [A `cloudflare.py:209`, `226-333`] | übernehmen, Threats ergänzen |
| Cache-TTLs | Tunnel 30 s, Certs 600 s, Analytics 300 s, Access 300 s [A `config.py:129-133`, `routers/cloudflare.py:35`] | Basis für Collector-Intervalle |
| ENV → configSchema | `CF_API_TOKEN`→`apiToken`, `CF_ACCOUNT_ID`→`accountId`, `CF_ZONE_ID`→`zoneIds[0]`, `CF_TUNNEL_ID`→`tunnelIds[0]`, `CF_ZONE_NAME` entfällt (aus API) [A `config.py:70-75`] | Migrationsskript |
| Fehlertexte | „Token-Scope unzureichend — 'Zone · Analytics: Read' fehlt.“ per String-Suche nach „403“ [A `cloudflare.py:281-282`] | strukturierte Codes (s. o.) |
| Alarme | Tunnel ≠ `healthy` → sofort Meldung, `down`=err sonst warn. API-Ausfall (`unknown`) löst ebenfalls „Tunnel degraded“ aus [A `notify.py:242-261`, `cloudflare.py:118-130`] | API-Ausfall vom Tunnel-Zustand trennen |

## Testbarkeit (Vertragstests)

- **Offizielles OpenAPI**: `github.com/cloudflare/api-schemas` (`openapi.json`, `openapi.yaml`, `common.yaml`) [D]. Fixtures lassen sich in CI gegen das Schema validieren.
- **Typen**: `cloudflare-typescript` (Stainless-generiert) mit vollständigen Response-Typen, z. B. `Shared.CloudflareTunnel`, `ConnectionsAPI.Client` [D]. Das Paket lässt sich alternativ direkt als Client nutzen (Abhängigkeitsentscheidung in Phase 2).
- **GraphQL**: Für GraphQL gibt es kein Schema im OpenAPI-Repo [?]. Fixtures werden aus echten Antworten aufgenommen und Feldnamen über den `settings`-Node (`availableFields`) [D] geprüft.
- **Altfixtures**: `backend/tests/test_cloudflare.py` (respx, **handgeschrieben**: Tunnel healthy/Fehler/429-Retry, Certificate-Pack-Dedupe, GraphQL-Aggregation/-Fehler) und `backend/tests/test_routers_misc.py:64-140` (Router mit Monkeypatch) [A]. Sie taugen als Testfall-Liste, nicht als Fixtures. Das Connections-Format ist falsch (s. o.).
- Empfehlung: einmalig mit echtem Token aufnehmen (Account-/Zone-/Tunnel-IDs, IPs und Hostnamen anonymisieren), dazu je ein Envelope für 401, 403, 429 (mit `Ratelimit`-Headern) und GraphQL-200-mit-`errors`.

## Aufwand & Empfehlung

- **Aufwand M**: Die API ist stabil, gut typisiert, und die Logik liegt im Altcode vor. Neu sind Multi-Zone und Multi-Tunnel, die doppelte Verify-Logik (User- oder Account-Token), die Plan-Erkennung per GraphQL-`settings`, Ratelimit-Header-Auswertung und die Purge-Aktion mit Audit.
- Abhängigkeiten: SDK-Aktionsvertrag + Audit (Purge), Secret-Store (zwei Tokens), Metric-Store (Traffic), Entity-Verknüpfung `Endpoint` → Uptime-Plugin (Ingress-Hostnames als Check-Vorschläge).
- Empfohlene Welle: **1** (vorhandene Integration, im Live-Betrieb genutzt).

## Offene Punkte

- Ein Token mit `Cache Purge` oder getrenntes `actionToken` (Empfehlung: getrennt)?
- Account-owned Token statt User-Token? Das braucht die Rolle „Super Administrator“ oder „API Token Provisioning“ [D].
- Welche Zonen außer `rxf-sys.de`? Sollen weitere Tunnel als die von CT 104 erscheinen?
- Threats auf dem Free-Plan: `firewallEventsAdaptive` mit dem echten Token prüfen (`settings`-Node) [?].
- Access-Login-Historie endgültig streichen oder als Option behalten?
- Lässt sich das Purge-Recht nebenwirkungsfrei vorab prüfen [?], oder reicht die Meldung beim ersten Aufruf?

## Quellen

1. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/fundamentals/api-rate-limits.mdx – 1.200 Req/5 min je User/Token, 200 Req/s je IP, GraphQL max. 320/5 min, 429-Sperre 5 min
2. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/fundamentals/api/reference/limits.mdx – Header `Ratelimit`, `Ratelimit-Policy`, `retry-after`
3. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/analytics/graphql-api/limits.mdx – 300 GraphQL-Queries/5 min, 10 Zonen je Query, Zählweise, 31 Tage Adaptive-Historie
4. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/analytics/graphql-api/features/discovery/settings.mdx – `settings`-Node (`enabled`, `maxDuration`, `maxPageSize`, `notOlderThan`, `availableFields`)
5. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/analytics/graphql-api/errors.mdx – GraphQL-Fehlertexte und HTTP-Codes, 200 mit `errors[]`
6. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/analytics/graphql-api/migration-guides/zone-analytics.mdx – Felder `requests`, `cachedRequests`, `bytes`, `threats` (`httpRequests1mGroups`)
7. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/release-notes/api-deprecations.yaml – Zone Analytics (01.03.2021), Argo Tunnel (04.02.2024), `connections`-Feld (EOL 05.10.2026)
8. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/fundamentals/api/reference/permissions.mdx – exakte Rechte-Namen (Cloudflare Tunnel Read, Zone Read, DNS Read, Analytics Read, SSL and Certificates Read, Cache Purge, Access: Audit Logs Read, Cloudflare One Connector: cloudflared Read)
9. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/fundamentals/api/get-started/create-token.mdx – Ablauf Token-Erstellung, Verify-Endpunkt, Präfix `cfut_`
10. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/fundamentals/api/get-started/account-owned-tokens.mdx – Account-owned Tokens, Inkompatibilitäten, benötigte Rolle
11. https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cache/how-to/purge-cache/index.mdx – Purge-Varianten je Plan, Limits Free 5/min Bucket 25, Single-File 800 URLs/s
12. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zero-trust/tunnels/cloudflared/cloudflared.ts – Tunnel-Endpunkte, List-Filter, Status-Enum
13. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zero-trust/tunnels/cloudflared/connections.ts – `Client`/`Conn`-Felder, `is_pending_reconnect` deprecated
14. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zero-trust/tunnels/cloudflared/connectors.ts und `configurations.ts` – Connector-Detail, Ingress-Konfiguration
15. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/shared.ts – `CloudflareTunnel` (`connections` deprecated, `conns_active_at`, `tun_type`, `config_src`)
16. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/ssl/certificate-packs/certificate-packs.ts – Pack-Felder, Status-/Typ-Enums, `status=all`
17. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/cache/cache.ts – `purge_cache`-Varianten, Semantik von `success:true`
18. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/user/tokens/tokens.ts und `accounts/tokens/tokens.ts` – Verify-Endpunkte und Antwortfelder
19. https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zones/zones.ts – `Zone.account`, Zonen-Status
20. https://github.com/cloudflare/api-schemas – offizielles OpenAPI (`openapi.json`/`.yaml`)
21. https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/get – [S] akzeptierte Rechte inkl. `Cloudflare One Connector: cloudflared Read`
22. https://developers.cloudflare.com/api/resources/ssl/subresources/certificate_packs/methods/list – [S] `SSL and Certificates Read`, per_page 5–50
23. https://developers.cloudflare.com/api/resources/zones/methods/list/ – [S] `Zone Read` für `GET /zones`
24. https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/ – [S] `Access: Audit Logs Read` für `access_requests`
25. https://community.cloudflare.com/t/api-access-error-9109/206487 – [S] Fehler 9109 bei IP-Filter
