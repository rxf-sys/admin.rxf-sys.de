# Altsystem – Kern-Analyse (Phase 1)

> Stand: 17.10.2026 · Grundlage: `backend/app/*` (Commit `0980314`), die vier
> Audit-Dateien im Repo-Root, `docs/SETUP.md`, `infrastructure/*`.
> Integrationen (Clients) sind in `docs/integrations/<plugin>.md` beschrieben;
> diese Datei deckt alles **außerhalb** der Clients ab.

## 1. Funktionsinventar → v2

Alles, was das Altsystem heute kann, und wo es in v2 hingehört. Drei
Funktionen sind im v2-Auftrag nicht vorgesehen und entfallen (Abschnitt 5).

| Funktion (alt) | Ort im Altcode | v2-Gegenstück | Status |
|---|---|---|---|
| Konten, Rollen `admin`/`operator`/`viewer` (+ Legacy `user`) | `app/accounts.py` (`users`) | Kern-Auth, gleiche drei Rollen | übernehmen (Konzept) |
| Sessions: Cookie `rxf_session`, 7 Tage TTL, nur `sha256`-Hash + Präfix in DB, Rotation beim Login | `app/accounts.py`, `app/routers/auth.py` | Kern-Auth | Muster übernehmen |
| TOTP mit Replay-Schutz (`last_used_step`), gehashte Backup-Codes | `app/totp.py` | Kern-Auth + neu Passkeys | Muster übernehmen |
| Login-Throttle 5 Fehlversuche / 300 s pro IP, proxy-aware über `trust_proxy_headers` | `app/routers/auth.py:26-62` | „Sperre mit Backoff“ | ausbauen (Backoff, pro Konto + IP) |
| Bootstrap-Admin per `BOOTSTRAP_ADMIN_PASSWORD` | `app/config.py:44-45` | Setup-Code im Log | ersetzen |
| `auth_enabled=False` schaltet Auth komplett ab (Dev) | `app/auth.py:7,40` | – | **nicht** übernehmen (Dev-Konto per Seed statt Auth-Bypass) |
| API-Bearer-Tokens `rxf_…` mit Scope `read`/`write`/`admin`, Minting-Ceiling | `app/accounts.py` (`api_tokens`), `app/auth.py:36-44` | nicht im Auftrag | entfällt (Abschnitt 5) |
| Audit-Log als In-Memory-Ringpuffer (200 Einträge, nach Neustart leer) | `app/audit.py` | persistentes, filter- und exportierbares Audit-Log | ersetzen |
| „Auditor“: kuratiertes Host-Audit-Skript lokal oder per SSH, Auto-Lauf täglich, Ergebnisse in `audit_runs` | `app/auditor.py`, `app/routers/auditor.py` | nicht im Auftrag (Überschneidung mit RMM „Vulpexa“) | entfällt (Abschnitt 5) |
| Eigene Services (`custom_services`) + Zuordnung Gast → Service (`guest_labels`) | `app/registry.py` | Uptime-Plugin (Ziele) + Entitäts-Verknüpfung Guest ↔ Service | übernehmen, Details in `uptime.md` |
| Probe-Historie + Incidents | `app/storage.py` (`probe_history`, `service_incidents`) | Uptime-Plugin, Zeitreihen | **migrieren** (ADR 0001) |
| Eigene Metrik-Samples für Gäste und WAN (`guest_metrics`, `network_metrics`) | `app/storage.py:57-73` | Kern-`Metric` | neu erfassen, **nicht** migriert (ADR 0001) |
| Benachrichtigungen: Webhook (Discord-Embed-Format), ntfy; Zustand nur im Speicher | `app/notify.py` | Alarmregeln + Kanal-Plugins | ersetzen |
| Schwellen: Service down > 180 s, Zertifikat < 14 Tage, Prüftakt 60 s | `app/config.py:156-162` | vorgeschlagene Alarmregeln | Werte als Defaults übernehmen |
| Wochenreport per SMTP (Mo 08:00 UTC): Service-Uptime, Backups, Audit-Läufe | `app/weekly_report.py`, `app/main.py:154-171` | im Auftrag nur als Ist-Stand erwähnt | entfällt (Abschnitt 5) |
| Instanz: Name, Zeitzone, 12h/24h | `app/routers/instance.py:20-33` | Onboarding Schritt 1 (+ Sprache) | übernehmen |
| UI-Einstellungen pro Konto, geräteübergreifend (`users.settings_json`) | `app/accounts.py`, `frontend/src/App.tsx` | Nutzer-Präferenzen | übernehmen |
| „AttentionHero“: Health-Score mit RAM/CPU-Schwellen, abgeleitete Alarme | `frontend/src/components/AttentionHero.tsx` (+ Tests) | Widget „Was braucht Aufmerksamkeit“ | Logik als Referenz |
| Kommandopalette, Tastenkürzel-Hilfe | `frontend/src/components/CommandPalette.tsx`, `ShortcutsHelp.tsx` | ⌘K über alle Plugins | neu bauen |
| Design-Tokens „v2 redesign“ (dunkel + hell, Dichte-Varianten) | `frontend/src/styles/tokens.css` | Token-System Phase 3 | Referenz neben Signal |

## 2. Lehren aus den Audits – Pflichtanforderungen für v2

Diese Fehler wurden im Altsystem gefunden und behoben. v2 muss sie von Anfang
an vermeiden; jede Zeile wird in Phase 2 ins Sicherheitsmodell übernommen und
bekommt in Phase 4/8 einen Test.

| # | Lehre | Herkunft |
|---|---|---|
| 1 | Token-Scopes serverseitig erzwingen; ein Token darf nie ein mächtigeres Token erzeugen | AUDIT_2026-06-10 #1 |
| 2 | Session beim Login rotieren, alte Session sofort widerrufen | AUDIT_2026-06-10 #2 |
| 3 | TOTP-Codes nur einmal pro Zeitschritt akzeptieren, auch den Setup-Code | AUDIT_2026-06-10 #3 |
| 4 | API-Doku (OpenAPI/Swagger) in Produktion nicht öffentlich | AUDIT_2026-06-10 #4 |
| 5 | SQLite: `PRAGMA foreign_keys = ON` auf **jeder** Verbindung | AUDIT_2026-06-10 #5 |
| 6 | Gleiche Antwortzeit für unbekannte, deaktivierte und falsche Logins (Dummy-Hash) | AUDIT_2026-06-10 #6, BACKEND_AUDIT „Status quo“ |
| 7 | Speicher von Rate-Limitern begrenzen (leere Buckets räumen) | AUDIT_2026-06-10 #7 |
| 8 | Jede Admin-Mutation landet im Audit-Log | AUDIT_2026-06-10 #8 |
| 9 | Nutzerangegebene URLs gegen Schema validieren (SSRF-Vorstufe) | AUDIT_2026-06-10 #9 |
| 10 | Reproduzierbare Builds (Lockfile + `ci`-Install) | AUDIT_2026-06-10 #10 |
| 11 | Security-Header: HSTS, CSP, `frame-ancestors 'none'`, Permissions-Policy | AUDIT_2026-06-10 #11 |
| 12 | CI: `permissions: contents: read`, Actions auf SHA gepinnt, `concurrency` | AUDIT_2026-06-10 #12 |
| 13 | Deploy wartet auf Healthcheck und schlägt sonst fehl | AUDIT_2026-06-10 #13 |
| 14 | Session-Tokens nur gehasht speichern | BACKEND_AUDIT #1 |
| 15 | Rollen auf **jedem** Aktions-Endpunkt serverseitig prüfen (Restart, Verify) | BACKEND_AUDIT #2, #3 |
| 16 | Client-IP nur aus Proxy-Headern, wenn der Proxy vertrauenswürdig konfiguriert ist (`CF-Connecting-IP`) | BACKEND_AUDIT #4 |
| 17 | Jeden Pfadparameter zu Geräte-APIs URL-encodieren (UPID-Fall) | BACKEND_AUDIT #6 |
| 18 | Fehlerantworten mit String-Meldung, strukturierte Daten in eigene Felder/Header | BACKEND_AUDIT #5 |
| 19 | Kein `window.confirm`; Dialoge mit `role="dialog"`, `aria-modal`, Fokusfalle | FRONTEND_AUDIT #3–5 |
| 20 | Timer/Subscriptions beim Unmount aufräumen | FRONTEND_AUDIT #6, AUDIT_2026-06-10 #15 |
| 21 | API-Antworten an der Grenze zur Laufzeit validieren (Zod) statt `as unknown as` | FRONTEND_AUDIT #7 |
| 22 | Kein stilles `.catch(() => {})`; Laden und Fehler sichtbar unterscheiden | FRONTEND_AUDIT #2, #9 |
| 23 | Keine hartcodierten Domains oder Konto-IDs, alles aus Konfiguration | HARDCODED_DATA_AUDIT |

## 3. Befunde aus dem Code, die v2 anders lösen muss

Beim Lesen aufgefallen und in keinem Audit adressiert:

| Befund | Ort | Konsequenz für v2 |
|---|---|---|
| Secrets liegen im Klartext in ENV und in SQLite: `smtp_password` und `ntfy_token` in `app_settings` | `app/routers/notifications.py:136-150`, `app/notify.py:105-107` | Secrets verschlüsselt (AES-256-GCM), nur schreibbar. Beim Import aus `app_settings` lesen, danach nicht mehr im Klartext halten |
| TLS-Prüfung für PVE, PBS und UniFi ist standardmäßig **aus** (`*_verify_tls = False`) | `app/config.py:60,68,87` | Fingerprint-Pinning (TOFU) statt Abschalten |
| Audit-Log nicht persistent (Ringpuffer) | `app/audit.py` | persistente Tabelle mit Aufbewahrung, Export |
| Kein expliziter CSRF-Schutz; verlässt sich auf `SameSite=Lax` + JSON-Body | `app/auth.py`, `app/main.py` | CSRF-Token oder Header-Prüfung für alles Zustandsändernde (Auftrag 8) |
| CSP erlaubt `style-src 'unsafe-inline'` und Google Fonts | `frontend/Caddyfile:31` | Fonts selbst hosten, keine externen Origins; `unsafe-inline` für Styles vermeiden, wo möglich |
| Persönliche Defaults im Code (`cf_account_id`, LAN-IPs, `probe_targets`) | `app/config.py:55-115` | keine fachlichen Defaults; Werte entstehen im Onboarding |
| Container laufen als root (bewusst offen gelassen wegen Volume-Ownership) | AUDIT_2026-06-10 „Bewusst nicht umgesetzt“ | frisches Volume in eigenem LXC → non-root ab Tag 1 |
| Benachrichtigungs-Zustand nur im Speicher; nach Deploy beginnt Entprellung neu | `app/notify.py:1-12` | Alarmzustand persistieren (sonst Doppel- oder verlorene Alarme beim Neustart) |

## 4. Quelle für den Umstieg (Phase 9)

Laut ADR 0001 werden **Konfiguration und Probe-Historie** übernommen.

### 4.1 Wo die alte Konfiguration liegt

1. **ENV** (`.env` im LXC, Pydantic-Settings ohne Präfix: Feld `proxmox_host` ↔ `PROXMOX_HOST`), Felder in `app/config.py`.
2. **Tabelle `app_settings`** (Laufzeit-Overrides aus der UI, haben Vorrang vor ENV):
   `instance_name`, `default_timezone`, `time_format`, `ntfy_base`, `ntfy_topic`, `ntfy_token`,
   `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `smtp_starttls`, `smtp_from`,
   `audit_auto_enabled`, `audit_auto_hour`, `weekly_report_enabled`, `report_hour`
   (+ interne Zeitstempel `auto_audit_last_run_date`, `weekly_report_last_week`).
3. **Tabellen `custom_services` und `guest_labels`** (Registry, `app/registry.py:30-51`).

### 4.2 Zuordnung ENV → v2

| Alt (ENV / Tabelle) | v2-Ziel |
|---|---|
| `PROXMOX_HOST`, `_PORT`, `_NODE`, `_TOKEN_ID`, `_TOKEN_SECRET`, `_VERIFY_TLS` | Plugin `proxmox-ve` |
| `PBS_HOST`, `_PORT`, `_TOKEN_ID`, `_TOKEN_SECRET`, `_DATASTORE`, `_VERIFY_TLS` | Plugin `proxmox-backup-server` |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_ZONE_NAME`, `CF_API_TOKEN`, `CF_TUNNEL_ID` | Plugin `cloudflare` |
| `UNIFI_HOST`, `_PORT`, `_API_KEY`, `_USERNAME`, `_PASSWORD`, `_SITE`, `_VERIFY_TLS`, `UNIFI_SITE_MANAGER_API_KEY`, `UNIFI_SITE_MANAGER_HOST_ID` | Plugin `unifi-network` |
| `PROBE_TARGETS` (JSON `{subdomain: interne URL}`), `PROBE_TIMEOUT_S`, `PROBE_INTERVAL_S`, Tabelle `custom_services` | Plugin `uptime` (Prüfziele) |
| Tabelle `guest_labels` (VMID → Service) | Verknüpfung `Guest` ↔ `Service` |
| `NOTIFY_WEBHOOK_URL` | Kanal-Plugin Webhook |
| `NTFY_BASE`, `NTFY_TOPIC`, `NTFY_TOKEN` (bzw. `app_settings`) | Kanal-Plugin ntfy |
| `SMTP_*`, `REPORT_TO` (bzw. `app_settings`) | Kanal-Plugin E-Mail |
| `NOTIFY_SERVICE_THRESHOLD_S`, `NOTIFY_CERT_DAYS` | Defaults der vorgeschlagenen Alarmregeln |
| `INSTANCE_NAME`, `DEFAULT_TIMEZONE`, `TIME_FORMAT` | Instanz-Einstellungen |
| `CACHE_TTL_*` | Referenz für Collector-Intervalle (15–600 s, siehe Plugin-Notizen) |
| `HISTORY_RETENTION_DAYS` (7) | Aufbewahrung der Probe-Rohdaten (v2: 48 h roh + Downsampling) |
| `AUDIT_*`, `WEEKLY_REPORT_ENABLED`, `REPORT_HOUR` | entfällt (Abschnitt 5) |

Nicht übernommen (ADR 0001): `users`, `sessions`, `api_tokens`, `user_totp`,
`audit_runs`, `guest_metrics`, `network_metrics`.

### 4.3 Hinweise aus den Default-Prüfzielen

Die Defaults in `app/config.py:104-115` zeigen, was heute im Heimnetz läuft:
Vaultwarden (`vault`), Nextcloud AIO (`cloud`, Port 11000), Immich (`photos`,
2283), Paperless (`docs`, 8000), Jellyfin (`media`, 8096), **Home Assistant**
(`ha`, 8123), ein Monitoring-Dienst (`monitor`, 3001) und PBS. Das ist eine
gute Vorlage für die Dashboard-Startvorlagen und bestätigt, dass Home
Assistant als MVP-Plugin ein reales Ziel hat. (Annahme: Die Defaults
entsprechen dem Live-Stand; die echte `.env` ist nicht im Repo.)

## 5. Entscheidungen zu den offenen Altfunktionen

Am 17.10.2026 entschieden: **API-Bearer-Tokens, Host-Audit („Auditor“) und
Wochenreport entfallen in v2.** `AUDIT_*`, `WEEKLY_REPORT_ENABLED` und
`REPORT_HOUR` werden beim Umstieg nicht übernommen. `SMTP_*` bleibt als
Quelle für das E-Mail-Kanal-Plugin.
