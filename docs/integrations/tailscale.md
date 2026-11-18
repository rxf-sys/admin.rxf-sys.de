# Tailscale (`tailscale`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick

- **Kategorie:** Netzwerk
- **Zweck:** Geräte im Tailnet mit Online-Status, „zuletzt gesehen“, Key-Ablauf, Client-Version und verfügbaren Updates anzeigen. Optional (opt-in) Gerät autorisieren oder Key-Ablauf abschalten.
- **API:** Cloud-API `https://api.tailscale.com/api/v2/…` (Tailscale-Koordinationsserver, kein lokales Gerät) [D]. Die Doku liegt heute unter https://tailscale.com/api. Im Repo `tailscale/tailscale` ist `api.md` nur noch ein Verweis darauf; die alten Markdown-Docs wurden am 13.09.2024 entfernt [D]. Für diese Analyse dienen die letzten Repo-Stände (`v1.56.0/api.md`, `v1.72.0/publicapi/*.md`) und der offizielle Go-Client `tailscale/tailscale-client-go-v2` als Primärquellen [D]. Neuere Details stammen aus der Websuche [S].
- **Versionen:** Die API ist als `v2` versioniert, eine Engine- oder Client-Mindestversion gibt es nicht. Headscale (selbst gehostet) hat eine andere API und wird nicht unterstützt [?].

## Verbindung & Auth

| Methode | Format | Lebensdauer | Bewertung | Quelle |
|---|---|---|---|---|
| **OAuth-Client** (heute Teil der „trust credentials“) | `POST https://api.tailscale.com/api/v2/oauth/token`, Formfelder `client_id`, `client_secret` (Client-Credentials-Flow) → JSON mit `access_token`, `token_type`, `expires_in: 3600`, `scope` | Access-Token 1 h, Client selbst läuft nicht ab | **Empfehlung** | [D] Token-URL + Flow (Go-Client), [S] Antwortfelder/1 h |
| API-Access-Token | `tskey-api-…`, Basic-Auth (Token als Benutzername, Passwort leer) oder `Authorization: Bearer …` | 1–90 Tage, danach manuell neu | Nur als Notlösung: läuft ab und erbt die Rechte des erzeugenden Nutzers | [D] Format, [S] Laufzeit/Rechte |

- Mit OAuth-Token: `Authorization: Bearer <access_token>` [D]. Das Plugin cached das Token und erneuert es etwa 5 min vor Ablauf. Der Go-Client nutzt dafür `oauth2.ReuseTokenSource` [D].
- **Tailnet-Pfad:** `-` steht für „default tailnet of the access token“ [D]. Der Go-Client verwendet standardmäßig ebenfalls `-` [D]. Den Tailnet-Namen muss der Nutzer also nicht kennen.
- **TLS:** öffentliches Zertifikat; System-Trust-Store verwenden. Fingerprint-Pinning ist nicht nötig, ein Pin würde bei Zertifikatsrotation brechen [?].
- **SSRF:** Ausgehend nur `api.tailscale.com:443`. `baseUrl` ist ein Expertenfeld mit fester Allowlist; der Go-Client und der Terraform-Provider erlauben ebenfalls einen Override [D].

### Entwurf `configSchema`

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `authMode` | enum `oauth` \| `apiToken` | ja | nein | Standard `oauth`. API-Tokens laufen nach spätestens 90 Tagen ab. |
| `clientId` | string | bei `oauth` | nein | Client-ID des OAuth-Clients (Scope `devices:core:read`) |
| `clientSecret` | string | bei `oauth` | **ja** | Secret des OAuth-Clients; wird vermutlich nur beim Anlegen angezeigt [?] |
| `apiToken` | string (`tskey-api-…`) | bei `apiToken` | **ja** | Nur falls kein OAuth-Client möglich ist |
| `apiTokenExpiresAt` | date | nein | nein | Ablaufdatum des API-Tokens, damit das Dashboard rechtzeitig warnt |
| `actionClientId` | string | nur bei Aktionen | nein | Zweiter OAuth-Client mit `devices:core`. Wird nur für Aktionen benutzt. |
| `actionClientSecret` | string | nur bei Aktionen | **ja** | – |
| `tailnet` | string | nein | nein | Standard `-` (Tailnet des Tokens) |
| `monitoredTags` | string[] | nein | nein | Offline-Alarme nur für Geräte mit diesen Tags, z. B. `tag:server` |
| `monitoredDevices` | string[] (`nodeId`) | nein | nein | Zusätzlich einzelne Geräte überwachen |
| `offlineAfterMinutes` | int 2–1440 | nein | nein | Standard 10 |
| `keyExpiryWarnDays` / `keyExpiryCritDays` | int | nein | nein | Standard 14 / 3 |
| `baseUrl` | url | nein | nein | Expertenfeld, Standard `https://api.tailscale.com` |

## Minimale Rechte

### Nur lesen

- **OAuth-Scope `devices:core:read`**, ohne Tags [S Scope-Name]. Der Scope-Name wird in Tailscale-eigenen Repos verwendet (`tailscale/accessbot`, Terraform-Tests) [D]. Tags sind laut Terraform-Doku nur Pflicht, wenn die Scopes `devices:core` oder `auth_keys` enthalten [D].
- Das deckt `GET /api/v2/tailnet/-/devices` und `GET /api/v2/device/{id}` ab [S]. `devices:core:read` ist eine Teilmenge von `devices:core` [S].
- Optional `devices:routes:read` für Subnet-Router/Exit-Node-Ansicht [S]. Nicht im MVP.
- Anlegen dürfen nur die Rollen Owner, Admin, Network admin und IT admin [S].

### Zusätzlich für Aktionen

- **`devices:core`** (lesen + schreiben). Das Credential **muss** dabei Tags bekommen [D]. Ein Network admin kann `devices:core` nicht vergeben, ein IT admin schon [S].
- `devices:core` umfasst laut Doku auch Autorisieren, Ablaufen-Lassen und Umtaggen [S], vermutlich auch Löschen [?]. Es ist also deutlich breiter als die zwei MVP-Aktionen. Deshalb **separater zweiter OAuth-Client**: Er wird nur bei einer Aktion zum Token-Holen benutzt, Polling läuft weiter mit dem Lese-Client.
- Für das Pflicht-Tag ein eigenes, sonst ungenutztes Tag (z. B. `tag:rxf-dashboard`) in `tagOwners` anlegen. Ein Client mit `devices:core` kann diese Tags an Geräte vergeben und damit ACL-Regeln auslösen [?].
- Ob Scopes eines bestehenden Clients änderbar sind oder ein neuer Client nötig ist: [?].

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

Statt eines API-Tokens wird ein OAuth-Client angelegt.

1. Im Admin-Panel unter *Settings → OAuth clients* bzw. *Trust credentials* anmelden: https://login.tailscale.com/admin/settings/oauth [D URL aus `tailscale/accessbot`]. Erforderlich ist die Rolle Owner, Admin, Network admin oder IT admin [S]. `[Screenshot: Einstellungen → OAuth clients]`
2. „Generate OAuth client…“ bzw. „Credential hinzufügen“ wählen, Beschreibung „rxf-admin (read)“ eintragen. `[Screenshot: Dialog neuer Client]`
3. Nur **Devices → Core → Read** (`devices:core:read`) anhaken, sonst nichts. Keine Tags nötig. `[Screenshot: Scope-Auswahl]`
4. Client-ID und Secret sofort kopieren; das Secret ist danach vermutlich nicht mehr einsehbar [?]. `[Screenshot: Secret-Anzeige]`
5. Im Dashboard *Plugins → Tailscale*: `authMode = oauth`, ID und Secret eintragen, „Verbindung testen“.
6. Nur wenn Aktionen gewünscht sind: einen zweiten Client „rxf-admin (actions)“ mit **Devices → Core → Write** (`devices:core`) und Tag `tag:rxf-dashboard` anlegen, vorher das Tag in der Policy unter `tagOwners` definieren. `[Screenshot: Write-Scope mit Tag]`
7. Doku verlinken: https://tailscale.com/kb/1215/oauth-clients · https://tailscale.com/docs/reference/trust-credentials · https://tailscale.com/api

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Access-Token | `POST /api/v2/oauth/token` | – | bei Bedarf, ca. alle 55 min | [D]/[S] |
| Geräteliste | `GET /api/v2/tailnet/-/devices?fields=default` | `Client` (Art `tailscale-node`) | 60 s / 5 min | [D] |
| Identität | `nodeId` (bevorzugt), `id` (Legacy), `name` (MagicDNS-Name), `hostname`, `user`, `os`, `addresses`, `tags` | `Client.externalId` = `nodeId` | mit Liste | [D] |
| Online | `connectedToControl` (bool); `lastSeen` ist leer, solange `connectedToControl` true ist | `Client.status`, `lastSeen` | mit Liste | [D] (Go-Client) |
| Zuletzt gesehen | `lastSeen` („when device was last active on the tailnet“) | `Client.lastSeen` | mit Liste | [D] |
| Key-Ablauf | `expires`, `keyExpiryDisabled`, `created` | Plugin-Daten + Alarm | mit Liste | [D] |
| Client/Update | `clientVersion`, `updateAvailable` (bei externen Geräten leer) | Plugin-Daten | mit Liste | [D] |
| Freigabe/Sicherheit | `authorized`, `isExternal`, `isEphemeral`, `blocksIncomingConnections`, `tailnetLockError` | Plugin-Daten + Alarm | mit Liste | [D] |
| Routen/Konnektivität | `fields=all` → zusätzlich `advertisedRoutes`, `enabledRoutes`, `clientConnectivity` (Endpoints, DERP-Latenz) | Plugin-Daten | nur Detailseite, on demand | [D] |
| Gerätedetail | `GET /api/v2/device/{nodeId}?fields=all` | `Client` | on demand | [D] |
| Subnet-Routen | `GET /api/v2/device/{id}/routes` (eigener Scope, s. o.) | – | nicht MVP | [D]/[S] |

Statusabbildung (Vorschlag) [?]: `connectedToControl` → `ok`. Offline bei überwachtem Gerät länger als `offlineAfterMinutes` → `crit`, nicht überwacht → `unknown` (Laptops und Handys sind oft offline). Key abgelaufen → `crit`. `authorized == false` → `warn`. `isExternal` → nur anzeigen, kein Status.

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Gerät autorisieren (nur bei aktivierter Geräte-Freigabe sinnvoll) | `POST /api/v2/device/{id}/authorized` Body `{"authorized": true}` | `low` (keine Unterbrechung, aber sicherheitsrelevant) | `admin` | `devices:core` + Tag | [D] |
| Key-Ablauf deaktivieren | `POST /api/v2/device/{id}/key` Body `{"keyExpiryDisabled": true}` | `low` | `admin` | `devices:core` + Tag | [D] |
| Key-Ablauf wieder aktivieren | dieselbe Route mit `false`. Das ursprüngliche Ablaufdatum bleibt erhalten [S]; liegt es in der Vergangenheit, fällt das Gerät sofort raus [?] | `medium` | `admin` | `devices:core` + Tag | [D]/[S] |
| Key ablaufen lassen (nicht MVP) | `POST /api/v2/device/{id}/expire` → `200 OK` leer; „require the device to re-authenticate“ | `high` (Gerät offline bis zur Neuanmeldung, ggf. nur vor Ort möglich) | `admin` | `devices:core` | [D] |
| Deautorisieren / Löschen / Tags setzen (nicht MVP) | `POST …/authorized` `false`, `DELETE /api/v2/device/{id}`, `POST …/tags` | `high` | `admin` | `devices:core` | [D] |

**Entscheidung MVP:** Das Plugin ist standardmäßig nur lesend. Opt-in gibt es genau zwei Aktionen, „Gerät autorisieren“ und „Key-Ablauf deaktivieren“, beide nur für `admin`, weil sie den Sicherheitszustand des Tailnets ändern. „Key ablaufen lassen“ bringt im Dashboard wenig und kann den Fernzugang kappen, deshalb nicht im MVP. Audit-Text z. B. „{user} hat Key-Ablauf für {name} ({nodeId}) deaktiviert“.

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| Tailnet-Status | Geräte online / offline / gesamt, Badge für wartende Freigaben | S |
| Geräteliste | Name, OS, Nutzer/Tags, online, zuletzt gesehen, Version, Update-Badge, Key-Ablauf | M, L, XL |
| Keys laufen bald ab | die nächsten N Geräte nach `expires` (nur ohne `keyExpiryDisabled`) | S, M |
| Updates verfügbar | Anzahl + Liste `updateAvailable` mit `clientVersion` | S, M |
| Überwachte Server | Ampel nur für `monitoredTags`/`monitoredDevices` | S, M |
| Neue Geräte | in den letzten 7 Tagen erstellt (`created`) | S, M |

### Seiten (Vorschlag)

- **Tailscale-Geräte:** filterbare Tabelle (Tag, OS, Nutzer, online, Update, Key-Ablauf), Spaltenwahl.
- **Gerätedetail:** alle Felder aus `fields=all`, Routen, DERP-Latenzen, Verlauf online/offline (aus eigenen Polls), Aktionsknöpfe (falls freigeschaltet).

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Key läuft bald ab | `!keyExpiryDisabled && expires - now < keyExpiryWarnDays` | `warn` |
| Key läuft sehr bald ab | `!keyExpiryDisabled && expires - now < keyExpiryCritDays` | `crit` |
| Key abgelaufen | `!keyExpiryDisabled && expires < now` | `crit` |
| Überwachtes Gerät offline | `connectedToControl == false` länger als `offlineAfterMinutes`, nur `monitoredTags`/`monitoredDevices` | `crit` |
| Gerät wartet auf Freigabe | `authorized == false` | `warn` |
| Neues Gerät im Tailnet | bisher unbekannte `nodeId`, nicht `isEphemeral` | `warn` |
| Client-Update offen | `updateAvailable == true` seit > 14 Tagen | `warn` |
| Tailnet-Lock-Problem | `tailnetLockError` nicht leer | `crit` |
| API-Token läuft ab | `authMode == apiToken && apiTokenExpiresAt - now < 7 Tage` | `warn` |
| Zugang ungültig | Token-Endpunkt liefert 401/400 | `crit` |

## Rate-Limits & Last

- **Rate-Limits sind nicht öffentlich dokumentiert** [?]. Weder alte Repo-Docs noch Suche nennen Zahlen. Der offizielle Go-Client behandelt 429 nicht gesondert [D]. Das Plugin behandelt 429 mit `Retry-After` (falls vorhanden) und exponentiellem Backoff [?].
- **Keine Paginierung:** „All results are returned at once“ (Stand 2024) [D]. Ein Request liefert das ganze Tailnet, die Last ist für Heimnetze trivial.
- Tokenbedarf: ein Token-Request pro Stunde [S]. Nicht pro Poll neu holen.
- `fields=default` reicht für Liste und Alarme; `fields=all` nur auf der Detailseite [D].
- Alternative zum Polling: Tailscale-Webhooks (z. B. `nodeNeedsApproval`, `nodeKeyExpiringInOneDay`) [S]. Sie bräuchten einen öffentlich erreichbaren Endpunkt am Cloudflare-Access-Schutz vorbei; nicht im MVP.

## Verbindungstest & Fehlercodes

Ablauf: Token holen (nur `oauth`) → `GET /api/v2/tailnet/{tailnet}/devices?fields=default` → Plausibilität (mind. 1 Gerät) → bei aktivierten Aktionen Token mit dem Action-Client holen und `POST /api/v2/device/rxf-probe-<zufall>/authorized` gegen ein nicht existierendes Gerät senden (404 = Recht vorhanden, 403 = fehlt) [?]. Fehlerantworten sind JSON mit `message` [D].

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | DNS-/TCP-/TLS-Fehler zu `api.tailscale.com` | „api.tailscale.com ist nicht erreichbar. Hat der Server Internetzugang (DNS, Proxy, Firewall)?“ |
| `OAUTH_INVALID_CLIENT` | Token-Endpunkt 400/401 | „OAuth-Client-ID oder Secret ist ungültig oder der Client wurde widerrufen.“ |
| `TOKEN_INVALID` | 401 auf API-Aufruf mit API-Token | „Der API-Token ist ungültig oder abgelaufen (API-Tokens gelten höchstens 90 Tage).“ |
| `SCOPE_MISSING_READ` | 403 auf `/devices` | „Dem Zugang fehlt der Scope `devices:core:read`.“ |
| `SCOPE_MISSING_WRITE` | 403 bei der Aktionsprobe | „Für Aktionen braucht der zweite OAuth-Client den Scope `devices:core` mit einem Tag.“ |
| `TAILNET_NOT_FOUND` | 404 auf `/tailnet/{tailnet}/devices` | „Tailnet ‚{tailnet}‘ nicht gefunden. Leer lassen bzw. `-` verwenden.“ |
| `RATE_LIMITED` | 429 | „Tailscale drosselt die Anfragen. Das Dashboard versucht es später erneut.“ |
| `EMPTY_TAILNET` | 200, aber leere Liste | „Verbindung ok, aber keine Geräte sichtbar. Gehört der Client zum richtigen Tailnet?“ |
| `UPSTREAM_ERROR` | 5xx | „Tailscale meldet einen Serverfehler: {message}“ |

## Eigenheiten & Stolperfallen

- **Online-Status:** `connectedToControl` ist das maßgebliche Feld. `lastSeen` ist leer, solange das Gerät verbunden ist [D]. In den API-Docs von 2023/2024 fehlt `connectedToControl` noch [D]; neuere Clients haben es. Fallback bei fehlendem Feld: `lastSeen` jünger als 5 min = online [?].
- **IDs:** `id` ist Legacy, `nodeId` ist der bevorzugte Bezeichner [D]. Für `externalId` immer `nodeId` nehmen.
- **Key-Ablauf:** Für getaggte Geräte ist der Ablauf standardmäßig deaktiviert. Ungetaggte Geräte laufen standardmäßig nach 180 Tagen ab [S]. `expires` bleibt auch bei `keyExpiryDisabled == true` gefüllt [S], also nie ohne Prüfung von `keyExpiryDisabled` alarmieren.
- **Externe/geteilte Geräte** (`isExternal`): `clientVersion`/`updateAvailable` leer, löschen nicht möglich [D]. Von Update- und Offline-Alarmen ausnehmen.
- **Ephemere Geräte** (`isEphemeral`) kommen und gehen [D Feld]. Kein „neues Gerät“- oder Offline-Alarm.
- **`devices:core` braucht Tags** [D]. Ein Lese-Client ohne Tags reicht für den Normalbetrieb.
- Benennung im Admin-Panel: „OAuth clients“ wurden mit Workload-Identity-Federation unter „Trust credentials“ zusammengefasst; Scopes wurden feiner gegliedert, alte Scopes (z. B. `devices`) sind „legacy“ [S]. Ältere Anleitungen nennen deshalb andere Namen.
- `AdvertisedRoutes` kommt im Go-Client mit großem Anfangsbuchstaben als JSON-Key (`"AdvertisedRoutes"`), `enabledRoutes` klein [D]. Beim Parsen beide Schreibweisen tolerieren [?].
- Die Posture-Endpunkte (`/attributes`) nennen in der Doku von 2024 noch die Legacy-Scopes `acl`/`devices` [D]. Nicht im MVP.
- Zeitstempel kommen als ISO-8601/RFC-3339-Strings in UTC [?]. Immer als UTC parsen.

## Wissen aus dem Altcode

**Keine Altintegration.** Im Repo gibt es außer der Plugin-Liste in `docs/adr/0001-kickoff-decisions.md` (Abschnitt 4, Zeile 71: „Tailscale | neu“) keinen Treffer für Tailscale, WireGuard oder VPN in `backend/app`, `frontend/src` oder `infrastructure/` [A]. Der Fernzugang zur Alt-App läuft über Cloudflare Tunnel (CT 104) [A].

## Testbarkeit (Vertragstests)

- **OpenAPI:** Ein Drittanbieter-Katalog listet eine OpenAPI-3.1-Spec der Tailscale-API [S]. Ob Tailscale sie offiziell zum Download anbietet, ist offen [?]. Bis dahin Zod-Schemas aus dem `Device`-Struct des offiziellen Go-Clients ableiten [D].
- **Vorhandene Fixtures:** `tailscale-client-go-v2/testdata/devices.json` (Geräteliste) und Erwartungswerte in `devices_test.go` [D]. Lizenz prüfen, eigene anonymisierte Aufnahme bevorzugen.
- **Aufnehmen:** Token-Antwort (Token geschwärzt), `/devices?fields=default` mit Gerät online, offline, getaggt (`keyExpiryDisabled`), Key bald ablaufend, `updateAvailable`, `isExternal`, `authorized:false`. Dazu `fields=all` eines Geräts und Fehlerantworten 401/403/404/429.
- **Mock:** Fastify-Testserver für `/api/v2/oauth/token` und `/api/v2/tailnet/-/devices`; Uhr im Test fixieren (Ablaufberechnungen).
- Altcode-Fixtures: keine [A].

## Aufwand & Empfehlung

- **Aufwand: S.** Ein Lese-Endpunkt ohne Paginierung, Standard-OAuth-Client-Credentials, keine TLS-Sonderfälle. Der meiste Aufwand steckt in Alarmlogik (Ablauf, überwachte Geräte) und der Zwei-Client-Konfiguration für Aktionen.
- **Abhängigkeiten:** SDK mit OAuth-Token-Cache (wiederverwendbar für andere Cloud-Plugins), Alarm-Engine, Aktionsvertrag + Audit (nur falls Aktionen aktiviert).
- **Empfohlene Welle:** Welle 2 (neue Plugins), früh. Guter Kandidat, um den Cloud-API- und OAuth-Pfad des SDK zu validieren.

## Offene Punkte

1. Welche Geräte gelten als „überwacht“ (Tags wie `tag:server` vorhanden)? Nutzt der Owner Tags überhaupt?
2. Ist im Tailnet die Geräte-Freigabe aktiv? Sonst ist „Gerät autorisieren“ überflüssig.
3. Sollen die zwei Aktionen überhaupt in den MVP, oder bleibt Tailscale v1 rein lesend?
4. Welcher Tailscale-Plan? Verfügbarkeit von OAuth-Clients und Rollen (IT admin) je Plan ist unbestätigt [?].
5. Offizielle Rate-Limits beim Tailscale-Support erfragen [?].
6. Verknüpfung von Tailscale-Geräten mit `Host`/`Guest` anderer Plugins (über `hostname`/IP)? Das entscheidet das Entitäten-ADR.

## Quellen

1. https://raw.githubusercontent.com/tailscale/tailscale/main/api.md – Verweis „moved to https://tailscale.com/api“
2. https://github.com/tailscale/tailscale/commits/main/api.md – alte Docs am 13.09.2024 entfernt
3. https://raw.githubusercontent.com/tailscale/tailscale/v1.56.0/api.md – Basic/Bearer-Auth, Tailnet `-`, Geräteattribute, Endpunktliste, `fields`
4. https://raw.githubusercontent.com/tailscale/tailscale/v1.72.0/publicapi/device.md – `expire`, `authorized`, `key`, `ip`, `attributes`, Request-Bodies, Posture-Scopes
5. https://raw.githubusercontent.com/tailscale/tailscale/v1.72.0/publicapi/readme.md – keine Paginierung, OAuth/Bearer
6. https://raw.githubusercontent.com/tailscale/tailscale-client-go-v2/main/devices.go – `Device`-Struct inkl. `connectedToControl`, `nodeId`, Methoden/Pfade, `fields`
7. https://raw.githubusercontent.com/tailscale/tailscale-client-go-v2/main/client.go – Basis-URL, Tailnet `-`, Basic-Auth, `APIError`, keine 429-Behandlung
8. https://raw.githubusercontent.com/tailscale/tailscale-client-go-v2/main/oauth.go – Token-URL `/api/v2/oauth/token`, Client-Credentials, Token-Wiederverwendung
9. https://raw.githubusercontent.com/tailscale/tailscale-client-go-v2/main/devices_test.go und https://github.com/tailscale/tailscale-client-go-v2/tree/main/testdata – Testdaten, Pfade
10. https://raw.githubusercontent.com/tailscale/terraform-provider-tailscale/main/docs/index.md und `docs/resources/oauth_client.md` – Scopes-Parameter, Tags Pflicht bei `devices:core`/`auth_keys`, `base_url`
11. https://github.com/tailscale/accessbot (README) – Scope `devices:core:read`, Admin-URL `/admin/settings/oauth`
12. https://tailscale.com/kb/1215/oauth-clients – 1-h-Token, `expires_in: 3600`, Rollen für Clients [S]
13. https://tailscale.com/docs/reference/trust-credentials – Scope-Liste, `devices:core` vs `:read`, Legacy-Mapping, Network admin vs IT admin [S]
14. https://tailscale.com/docs/reference/tailscale-api – API-Tokens 1–90 Tage [S]
15. https://tailscale.com/docs/features/access-control/key-expiry – 180 Tage Standard, getaggte Geräte ohne Ablauf [S]
16. https://tailscale.com/docs/features/webhooks – Webhook-Ereignisse [S]
17. Altcode/Repo: `docs/adr/0001-kickoff-decisions.md:71`, `infrastructure/setup-lxc.sh:124`
