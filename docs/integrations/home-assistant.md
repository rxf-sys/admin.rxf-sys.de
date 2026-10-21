# Home Assistant (`home-assistant`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick

- Kategorie: Smart Home
- Zweck: ausgewählte Home-Assistant-Entitäten als Widgets zeigen (Wert, Schalter, Verlauf, Thermostat) und – optional, opt-in – einzelne freigegebene Entitäten schalten.
- Versionen: Doku/Quellcode-Stand Core **2026.10.2** (16.10.2026) [D]. Mindestversion für `subscribe_entities` und `history/stream` nicht ermittelt [?] – Vorschlag: nur aktuelle Releases (≥ 2025.1) offiziell unterstützen und in `test()` die Version anzeigen.
- Lokal: REST-API und WebSocket-API auf derselben Adresse wie das Frontend [D]. Nabu-Casa-Fernzugang technisch möglich, aber nicht vorgesehen (Cloud-Abhängigkeit, SSRF-Allow-List).
- Beim Owner: HA läuft als Proxmox-Gast 200 und als Probe-Ziel `http://192.168.2.208:8123` [A `backend/app/config.py:111`, `backend/app/clients/proxmox.py:22`].

## Verbindung & Auth

- **Auth:** Long-Lived Access Token (LLAT) als `Authorization: Bearer <TOKEN>`; nur JSON [D].
- **WebSocket** `ws(s)://<host>:<port>/api/websocket` [D]:
  1. Server → `{"type":"auth_required","ha_version":"…"}`
  2. Client → `{"type":"auth","access_token":"<TOKEN>"}`
  3. Server → `{"type":"auth_ok",…}` oder `{"type":"auth_invalid","message":"…"}` + Verbindungsabbau
  4. Optional zuerst `{"id":1,"type":"supported_features","features":{"coalesce_messages":1}}` (Bündelung) [D]
  5. Danach braucht jede Nachricht eine eindeutige, steigende `id`; Keepalive per `{"type":"ping"}` → `pong` [D].
- **Port:** laut Doku 80 bei HA OS, sonst 8123 (änderbar) [D]; beim Owner 8123 [A].
- **Token-Lebensdauer:** im UI erstellte LLAT gelten **3650 Tage** [D Frontend]; die WS-API `auth/long_lived_access_token` verlangt `lifespan` (Tage) und `client_name` [D]. Der Token wird für den **gerade angemeldeten Benutzer** erstellt und nur einmal angezeigt [D].
- **Keine Scopes:** Ein LLAT hat exakt die Rechte seines Benutzers (siehe Minimale Rechte).
- **TLS:** Standard ist HTTP. HTTPS nur mit `http: ssl_certificate` oder Reverse-Proxy [?]. Selbstsigniert möglich → Fingerprint-Pinning für REST **und** WSS über denselben TLS-Helper.

**Entwurf `configSchema`**

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `baseUrl` | url | ja | nein | z. B. `http://192.168.2.208:8123` – ohne `/api` |
| `accessToken` | string | ja | ja | LLAT des **Nicht-Admin**-Benutzers `rxf-dashboard` |
| `tlsFingerprint` | string | nein | nein | nur bei HTTPS, TOFU |
| `entities` | array `EntityRef` (1–200) | ja | nein | Entity-Picker (siehe unten) |
| `liveMode` | enum `websocket`\|`polling` | nein | nein | Default `websocket`; `polling` als Notlösung hinter Proxys ohne WS |
| `historyHours` | int (1–240) | nein | nein | Spanne der Sparklines, Default 24 |

**Generischer Entity-Picker (Vorschlag)**

```ts
const EntityRef = z.object({
  entityId: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/),   // z. B. sensor.wohnzimmer_temperatur
  label: z.string().max(60).optional(),                     // Anzeige-Override
  widget: z.enum(['auto', 'value', 'toggle', 'sparkline', 'climate', 'binary']).default('auto'),
  control: z.object({                                       // nur sichtbar, wenn Aktionen im Plugin aktiv
    enabled: z.boolean().default(false),
    services: z.array(z.string()).default([]),              // Teilmenge aus DOMAIN_SERVICE_ALLOWLIST
    risk: z.enum(['low', 'medium', 'high']).optional(),     // Override, z. B. Steckdose am Server = high
  }).optional(),
});
// Formular-Hinweis an das SDK: { 'x-options-provider': 'home-assistant.entities' }
```

- Optionen-Provider (serverseitig, nur im Einstellungsdialog): WS `get_states` + `config/entity_registry/list_for_display` + `config/area_registry/list` – alle drei **ohne** Admin-Recht [D]. Suche nach Name, Bereich, Domain, `device_class`.
- `auto` wählt das Widget aus Domain und Attributen: `switch`/`light`/`fan`/`input_boolean` → Schalter, `climate` → Thermostat, `sensor` mit Zahl + `unit_of_measurement` → Sparkline, `binary_sensor` → Binär, sonst Wert.

## Minimale Rechte

Home Assistant hat **keine Token-Scopes**. Rechte hängen an Benutzergruppen [D]:

| Gruppe | `group_id` | Policy | Im UI wählbar |
|---|---|---|---|
| Administrators | `system-admin` | `{entities: True}` + alle Admin-Befehle | ja („Administrator“) |
| Users | `system-users` | `{entities: True}` – Lesen **und** Steuern aller Entitäten | ja (Standard für Nicht-Admins) |
| Read Only | `system-read-only` | `{entities: {all: {read: True}}}` | nein [?] – nur per WS `config/auth/update` mit `group_ids` (Admin) [D] |

### Nur lesen

- **Empfehlung:** eigener Benutzer `rxf-dashboard`, **kein Administrator**. Damit gehen `GET /api/`, `/api/config`, `/api/states*`, `/api/history/*`, WS `get_states`, `subscribe_entities`, `history/*`, `recorder/statistics_during_period` [D]. Gesperrt sind u. a. `POST /api/states`, `POST /api/events`, `POST /api/template`, `/api/error_log`, WS `fire_event`, `subscribe_trigger`, `execute_script`, Registry-Änderungen [D].
- **Restrisiko:** Auch ein Nicht-Admin kann fast **alle Services/Actions aufrufen**. `POST /api/services/<domain>/<service>` und WS `call_service` prüfen keine Admin-Rolle [D]; Entity-Services prüfen `control`, das `system-users` für **alle** Entitäten hat [D]. Ein geleakter Token kann also z. B. Schlösser öffnen, Alarmanlagen deaktivieren oder Garagentore bewegen. Nur Admin-Services (z. B. `homeassistant.stop`) sind gesperrt [D].
- **Härtung (optional, fortgeschritten):** Benutzer per WS `config/auth/update` in `system-read-only` verschieben → Entity-Services werden mangels `control` abgelehnt [D]. Ob alle Nicht-Entity-Services (z. B. `notify.*`, direkte Skript-Services) das respektieren, ist nicht belegt [?]; das UI zeigt die Gruppe nicht an [?]. Nur für reinen Lesebetrieb sinnvoll.
- Optional „nur aus dem lokalen Netz anmelden“ (`local_only`) für den Benutzer setzen; Wirkung auf LLAT-Requests [?].

### Zusätzlich für Aktionen

- HA-seitig: Benutzer muss in `system-users` sein (nicht `system-read-only`); mehr gibt HA nicht her.
- **Die eigentliche Rechtegrenze liegt im Plugin:** deny-by-default, nur explizit pro Entität freigegebene Services aus dieser festen Liste:

| Domain | erlaubte Services | Default-Risiko |
|---|---|---|
| `light` | `turn_on`, `turn_off`, `toggle` | low |
| `switch`, `fan`, `input_boolean` | `turn_on`, `turn_off`, `toggle` | medium (Steckdose kann Infrastruktur versorgen) |
| `climate` | `set_temperature`, `set_hvac_mode` | low |
| `scene` | `turn_on` | medium |
| `cover` | `open_cover`, `close_cover`, `stop_cover` | high (Garagentor/Sicherheit) |
| `lock`, `alarm_control_panel`, `homeassistant`, `hassio`, `script`, `automation`, `shell_command`, `rest_command`, `notify` | **gesperrt** | – |

Services-Namen aus `services.yaml` der jeweiligen Integration [D]. Das Plugin sendet immer ein konkretes `entity_id` (nie `all`, nie `area_id`).

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

1. Als Admin: **Einstellungen → Personen → Person hinzufügen**, Name `rxf-dashboard`, „Anmeldung erlauben“ an, Benutzername + Passwort, **„Administrator“ aus** [?] (UI-Bezeichnungen nicht geprüft). `[Screenshot: Person anlegen, Administrator-Schalter aus]`
2. Abmelden und **als `rxf-dashboard` anmelden** – der Token gehört immer dem angemeldeten Benutzer [D].
3. Unten links auf den Benutzernamen → **Profil → Reiter „Sicherheit“** → „Langlebige Zugangs-Token“ → **Token erstellen**, Name `rxf-admin` [D Frontend: `ha-profile-section-security`; Beschriftung [?]]. `[Screenshot: Profil › Sicherheit › Token erstellen]`
4. Token sofort kopieren – er wird nur einmal angezeigt [D]. `[Screenshot: Token-Dialog]`
5. URL + Token eintragen → „Verbindung testen“ → Entitäten im Picker wählen.
6. Widerruf jederzeit unter Profil → Sicherheit (als `rxf-dashboard`) oder durch Deaktivieren des Benutzers.
- Herstellerdoku: https://developers.home-assistant.io/docs/api/rest/ · https://developers.home-assistant.io/docs/api/websocket/

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| API läuft (`{"message":"API running."}`) | `GET /api/` | `Service` | `test()` + Fallback 60 s | [D] |
| Instanz: `version`, `state`, `location_name`, `time_zone`, `unit_system`, `recovery_mode`, `safe_mode`, `external_url`, `internal_url` | `GET /api/config` bzw. WS `get_config` | `Service` | 5 min / 30 min | [D] |
| Live-Zustände der gewählten Entitäten | WS `subscribe_entities` mit `entity_ids` → Events `a` (neu), `c` (Diff `+`/`-`), `r` (entfernt); Felder `s`, `a`, `c`, `lc`, `lu` | plugin-spezifisch `haEntity` + `Metric` (numerisch) | Push / Push | [D] |
| Einzelzustand (Fallback/Polling) | `GET /api/states/<entity_id>` | dito | 30 s / 10 min | [D] |
| Alle Zustände (nur Picker) | WS `get_states` (bzw. `GET /api/states`) | – | nur im Dialog | [D] |
| Bereiche, Anzeigenamen | WS `config/area_registry/list`, `config/entity_registry/list_for_display` | – | nur im Dialog / 24 h | [D] |
| Verlauf für Sparklines | WS `history/history_during_period` (`entity_ids`, `start_time`, `minimal_response`, `no_attributes`, `significant_changes_only`) bzw. `GET /api/history/period/<ts>?filter_entity_id=…&minimal_response&no_attributes` | `Metric` (Backfill) | einmalig, dann aus eigenen Push-Werten | [D] |
| Langzeit-Statistik (> 10 Tage) | WS `recorder/statistics_during_period` (`statistic_ids`, `start_time`, …) | `Metric` | 1 h / 6 h | [D] Parameter `period` [?] |
| Benutzer des Tokens (`is_admin`, `is_owner`) | WS `auth/current_user` | – | `test()` | [D] |
| Service-Katalog (für Aktions-Picker) | WS `get_services` bzw. `GET /api/services` | – | nur im Dialog | [D] |
| Verfügbare Updates | Entitäten `update.*` (Zustand `on`) über `subscribe_entities` | `Alert` | Push | [?] |

Hinweis SDK: `subscribe_entities` passt nicht ins reine Polling-Modell. Vorschlag: **Stream-Collector** (eine WS-Verbindung pro Instanz, Push in den Cache), Watchdog per `ping` alle 30 s, Reconnect mit Backoff; wenn niemand zuschaut, Verbindung halten (billig) oder auf 15-min-REST-Polling fallen.

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Licht an/aus/umschalten | WS `call_service` `{"domain":"light","service":"toggle","target":{"entity_id":"…"}}` bzw. `POST /api/services/light/toggle` | low | operator | Entität + Service freigegeben, Benutzer nicht read-only | [D] |
| Schalter/Lüfter/Helper an/aus | `switch`/`fan`/`input_boolean` `turn_on`/`turn_off`/`toggle` | medium (Override möglich) | operator | dito | [D] |
| Solltemperatur | `climate.set_temperature` `{"entity_id","temperature"}` (oder `target_temp_low/high`) | low | operator | dito | [D] |
| HVAC-Modus | `climate.set_hvac_mode` `{"entity_id","hvac_mode"}` | low | operator | dito | [D] |
| Szene aktivieren | `scene.turn_on` | medium | operator | dito | [D] |
| Rollladen/Tor | `cover.open_cover`/`close_cover`/`stop_cover` | high | admin | dito + Re-Authentifizierung | [D] |

Audit-Text: „{user} hat {service} für {entity_id} ({friendly_name}) auf {instanz} ausgeführt.“ Antwort-`context.id` mitloggen (WS-Ergebnis enthält `context`) [D].

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| Entitätswert | Zustand + Einheit + Icon, „nicht verfügbar“ grau, letzte Änderung | S |
| Schalter | Toggle für `switch`/`light`/`fan`/`input_boolean`; ohne Aktionsrecht nur Anzeige | S |
| Binärsensor | Tür/Fenster/Bewegung mit `device_class`-Text | S |
| Sensor-Sparkline | numerischer Sensor über `historyHours`, Min/Max/aktuell | S, M |
| Thermostat | `current_temperature`, Sollwert (`temperature`), `hvac_mode`/`hvac_action`, +/- in `target_temp_step` | M |
| Entitätsgruppe | mehrere Entitäten, gruppiert nach Bereich | M, L |
| HA-Status | Version, verbunden ja/nein, nicht verfügbare Entitäten, Updates | S, M |

### Seiten (Vorschlag)

- **Smart Home**: Raster aller gewählten Entitäten nach Bereich, Filter nach Domain; Detail-Drawer mit Verlauf und (falls freigegeben) Steuerung. Kein Ersatz für das HA-Dashboard.

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Home Assistant nicht erreichbar | WS getrennt und `GET /api/` schlägt fehl > 2 min | crit |
| HA im Recovery-/Safe-Mode | `/api/config` `recovery_mode` oder `safe_mode` = true | crit |
| Entität nicht verfügbar | gewählte Entität `unavailable` > 10 min | warn |
| Batterie schwach | `device_class: battery` < 20 % | warn |
| Schwellwert (Vorlage) | numerischer Sensor über/unter X für Y min (z. B. Serverraum > 30 °C) | warn / crit |
| Updates verfügbar | `update.*` = `on` | info |
| Token mit Admin-Rechten | `auth/current_user.is_admin` = true | warn |

## Rate-Limits & Last

- Kein dokumentiertes API-Rate-Limit [?]. HA läuft in einer Event-Loop; viele REST-Polls (v. a. `GET /api/states` mit allen Entitäten) kosten spürbar → WS-Abo mit `entity_ids`-Filter ist die schonendste Variante.
- Fehlgeschlagene Auth erzeugt je Versuch eine Log-Warnung „Login attempt or request with invalid authentication from …“ **und** eine persistente Benachrichtigung „Login attempt failed“ (`http-login`) [D]. IP-Bann nur, wenn `http: login_attempts_threshold` gesetzt ist (Default `-1` = aus) [D] → das Plugin muss nach `401` sofort stoppen (Circuit-Breaker), sonst wird der Admin zugespammt oder das Dashboard gebannt.
- Recorder-Rohdaten werden nach `purge_keep_days` (Default **10**) gelöscht [D]; längere Sparklines nur über Langzeit-Statistik.
- `history/*` immer mit `entity_ids` und `minimal_response`/`no_attributes` aufrufen; die REST-Variante verlangt `filter_entity_id` [D].

## Verbindungstest & Fehlercodes

Ablauf: `GET /api/` → `GET /api/config` (Version, `state`) → WS verbinden + `auth` → `auth/current_user` → `get_states` und Abgleich der konfigurierten `entities` → WS schließen.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | DNS-/TCP-Fehler, Timeout | „Home Assistant nicht erreichbar. Adresse und Port (meist 8123) prüfen.“ |
| `CERT_UNKNOWN` / `CERT_PIN_MISMATCH` | TLS-Fehler / Fingerprint ≠ Pin | „Zertifikat unbekannt bzw. geändert. Fingerprint prüfen.“ |
| `NOT_HOME_ASSISTANT` | `/api/` liefert kein JSON mit `message` | „Unter dieser Adresse läuft kein Home Assistant.“ |
| `TOKEN_INVALID` | REST `401` bzw. WS `auth_invalid` | „Token ungültig oder widerrufen. Neuen Token erstellen.“ |
| `HA_STARTING` | `/api/config.state` ≠ `RUNNING` | „Home Assistant startet gerade – gleich erneut versuchen.“ |
| `TOKEN_IS_ADMIN` (Warnung) | `is_admin` oder `is_owner` = true | „Token gehört einem Administrator. Empfohlen: eigener Nicht-Admin-Benutzer.“ |
| `READ_ONLY_USER` (Info) | Aktionen aktiv, aber erster Service-Call liefert WS-Fehler `unauthorized`; `auth/current_user` liefert **keine** `group_ids` [D], daher keine Vorab-Erkennung | „Benutzer ist schreibgeschützt – Aktionen schlagen fehl.“ |
| `ENTITY_NOT_FOUND` | Entität fehlt in `get_states` / `404` | „Entität {id} existiert nicht (umbenannt oder gelöscht?).“ |
| `WS_BLOCKED` | Upgrade auf `/api/websocket` scheitert, REST geht | „WebSocket blockiert (Reverse-Proxy?). Live-Updates aus, Polling aktiv.“ |
| `ACTION_NOT_ALLOWED` | Plugin-Allow-List greift (vor dem Request) | „Diese Aktion ist für {entity} nicht freigegeben.“ |
| `ACTION_UNAUTHORIZED` | REST `401` bzw. WS-Fehler `unauthorized` (`ERR_UNAUTHORIZED`) beim Service-Call [D] | „Home Assistant verweigert die Aktion (Benutzerrechte).“ |

## Eigenheiten & Stolperfallen

- Seit 2024.8 heißen „Services“ im UI „Actions“; API-Pfade und WS-Typen (`/api/services/…`, `call_service`) blieben unverändert [S].
- Entity-IDs sind vom Nutzer umbenennbar → Allow-List bricht still. `test()` und Collector melden fehlende IDs als `ENTITY_NOT_FOUND`, nie stillschweigend.
- Zustände sind immer **Strings** (`"21.5"`, `"on"`, `"unavailable"`, `"unknown"`); Einheit in `attributes.unit_of_measurement`.
- Zeitstempel: REST ISO-8601, WS-komprimiert Unix-Sekunden (`lc`, `lu`); einer der beiden kann fehlen, wenn beide gleich sind [D] → Parser muss fehlende Felder vom anderen übernehmen.
- `POST /api/states/<id>` setzt nur den Zustand in HA, **nicht** am Gerät [D] – nie für Aktionen verwenden.
- `GET /api/` braucht die Integration `api` (bei Frontend-Nutzung automatisch dabei) [D].
- **Überschneidung FRITZ!Box:** HA bringt die Integration `fritzbox` („FRITZ!SmartHome“, `local_polling`) für DECT-Thermostate und -Steckdosen mit [D]. Läuft sie, sind dieselben Geräte über HA **und** das FRITZ!Box-Plugin sichtbar. Vorschlag: DECT-Smart-Home nur über **eine** Quelle anzeigen (bevorzugt HA, wenn vorhanden), das FRITZ!Box-Plugin bleibt bei Router/WAN/WLAN; das entlastet auch die AHA-Schnittstelle der Box.

## Wissen aus dem Altcode

Keine Altintegration. (HA kommt im Altcode nur als HTTP-Probe-Ziel `ha` [A `backend/app/clients/probes.py:23`, `backend/app/config.py:111`] und als Gast-Label 200 [A `backend/app/clients/proxmox.py:22`] vor – ohne API-Zugriff.)

## Testbarkeit (Vertragstests)

- Keine offizielle OpenAPI-/JSON-Schema-Datei für REST oder WebSocket bekannt [?]; Referenz sind `developers.home-assistant` (`docs/api/rest.md`, `docs/api/websocket.md`) und der Core-Quellcode [D].
- Fixtures einmalig gegen einen HA-Container mit der Integration `demo` aufzeichnen (bringt u. a. `climate`-Entitäten mit [D]): REST-Antworten und **WS-Transkripte** (Nachrichtenfolge inkl. `auth_required` → `auth_ok` → `result` → `event` mit `a`/`c`/`r`).
- Mock-WS-Server im Test spielt die Transkripte ab; Szenarien: `auth_invalid`, Verbindungsabbruch + Reconnect, Entität verschwindet (`r`), `unavailable`, Service-Call mit `unauthorized`, HA-Neustart (`state` ≠ `RUNNING`).
- Allow-List-Logik rein im Plugin → Unit-Tests ohne Netz (gesperrte Domains, `entity_id`-Pflicht, kein `all`).
- Keine Alt-Fixtures vorhanden.

## Aufwand & Empfehlung

- Aufwand: **L** – lesend allein **M** (WS-Client mit Auth/Reconnect/Ping, Diff-Format, Entity-Picker mit Options-Provider, 4–5 generische Widgets, History-Backfill); dazu Aktionen mit Allow-List, Risiko-Override pro Entität und Re-Auth (**+M**).
- Abhängigkeiten im SDK: **Stream-Collector** (Push statt Poll), **dynamische Options-Provider** im `configSchema`-Formular, Aktions-Parameter abhängig von der Entität, Risiko pro Aktions-Instanz (nicht nur pro Aktionstyp), TLS-Pinning auch für WebSocket.
- Welle: **Welle 2** (neue Plugins), eher spät darin, weil sie die zwei neuen SDK-Bausteine (Stream-Collector, Options-Provider) braucht. Erst lesend ausliefern, Aktionen als Folgeschritt.

## Offene Punkte

1. Welche Entitäten/Domains will der Owner sehen, welche schalten? (Bestimmt die Default-Allow-List.)
2. Ist `system-read-only` per WS-Befehl für den Owner akzeptabel, wenn er gar keine Aktionen will?
3. Wirkung von `local_only` auf LLAT-Requests [?]; Mindest-HA-Version für `subscribe_entities` [?].
4. FRITZ!DECT: über HA oder über das FRITZ!Box-Plugin anzeigen?
5. Darf das Dashboard eine dauerhafte WS-Verbindung halten, auch wenn niemand zuschaut?

## Quellen

1. https://github.com/home-assistant/developers.home-assistant/blob/master/docs/api/rest.md – Endpunkte, Bearer-Header, Port, `filter_entity_id`, `api`-Integration, `POST /api/states` ändert Gerät nicht
2. https://github.com/home-assistant/developers.home-assistant/blob/master/docs/api/websocket.md – Auth-Ablauf, `id`, `coalesce_messages`, `subscribe_events`, `call_service`, `get_states`, `ping`
3. https://github.com/home-assistant/developers.home-assistant/blob/master/docs/auth_permissions.md – Policies `read`/`control`/`edit`, Entity-Services prüfen automatisch, `async_register_admin_service`
4. https://github.com/home-assistant/core/blob/dev/homeassistant/components/api/__init__.py – welche REST-Views Admin verlangen; Service-View ohne Admin-Prüfung
5. https://github.com/home-assistant/core/blob/dev/homeassistant/components/websocket_api/commands.py – `subscribe_entities` mit `entity_ids`, Rechtefilter, Admin-only-Befehle
6. https://github.com/home-assistant/core/blob/dev/homeassistant/components/websocket_api/messages.py und `homeassistant/const.py` – Diff-Format `a`/`c`/`r`, `+`/`-`, `s`/`a`/`c`/`lc`/`lu`
7. https://github.com/home-assistant/core/blob/dev/homeassistant/auth/permissions/system_policies.py, `auth/const.py`, `auth/auth_store.py` – Gruppen und Policies
8. https://github.com/home-assistant/core/blob/dev/homeassistant/auth/permissions/events.py – `SUBSCRIBE_ALLOWLIST`, `state_changed` gefiltert
9. https://github.com/home-assistant/core/blob/dev/homeassistant/components/auth/__init__.py – `auth/long_lived_access_token`, `auth/current_user` (`is_admin`, `is_owner`)
10. https://github.com/home-assistant/frontend/blob/dev/src/panels/profile/ha-long-lived-access-token-dialog.ts – `lifespan: 3650`; `ha-profile-section-security.ts` – Token im Reiter Sicherheit
11. https://github.com/home-assistant/core/blob/dev/homeassistant/components/config/auth.py – `config/auth/update` mit `group_ids` (Admin)
12. https://github.com/home-assistant/core/blob/dev/homeassistant/components/config/entity_registry.py und `area_registry.py` – Listen ohne Admin-Recht
13. https://github.com/home-assistant/core/blob/dev/homeassistant/components/history/websocket_api.py – `history/history_during_period`, `history/stream`, Rechtefilter
14. https://github.com/home-assistant/core/blob/dev/homeassistant/components/recorder/websocket_api.py und `recorder/__init__.py` – `statistics_during_period`, `purge_keep_days` 10
15. https://github.com/home-assistant/core/blob/dev/homeassistant/helpers/service.py – `POLICY_CONTROL`-Filter bei Entity-Services
16. https://github.com/home-assistant/core/blob/dev/homeassistant/components/homeassistant/services.py – `homeassistant.stop` als Admin-Service
17. https://github.com/home-assistant/core/blob/dev/homeassistant/components/http/ban.py und `http/const.py` – Warnung + Benachrichtigung `http-login`, Bann-Schwelle Default `-1`
18. https://github.com/home-assistant/core/blob/dev/homeassistant/core_config.py – Felder von `/api/config`
19. https://github.com/home-assistant/core/tree/dev/homeassistant/components/climate, `cover`, `switch`, `scene` (`services.yaml`) – Service-Namen und Felder
20. https://github.com/home-assistant/core/blob/dev/homeassistant/components/fritzbox/manifest.json – Integration „FRITZ!SmartHome“
21. https://github.com/home-assistant/core/releases – aktuelle Version 2026.10.2 (16.10.2026)
22. https://www.home-assistant.io/blog/2024/08/07/release-20248/ – Umbenennung Services → Actions [S]
