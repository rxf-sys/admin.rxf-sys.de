# Sicherheit (v2)

Lebendes Dokument zu ADR 0008. Es enthält die Bedrohungstabelle mit Stand der Umsetzung, die
ASVS-Checkliste (OWASP ASVS 5, Level 2) und den Meldeweg. Phase 8 prüft jede Zeile mit einem Test oder
einer dokumentierten manuellen Prüfung.

Stand: Ende Phase 4 (19.11.2026).

## Sicherheitslücken melden

Bitte **nicht** als öffentliches Issue. Stattdessen über GitHub: im Repository unter **Security → Report a
vulnerability** (private Meldung an den Owner). Die Funktion muss der Owner einmal unter Settings → Code
security → „Private vulnerability reporting“ einschalten.

Gemeldet werden kann alles, was den v2-Code betrifft (`apps/`, `packages/`, `infrastructure-v2/`). Der
Altcode (`backend/`, `frontend/`) wird bis zum Abbau nur noch bei kritischen Lücken angefasst.

## Bedrohungen und Stand

| # | Bedrohung | Gegenmaßnahme | Stand |
|---|---|---|---|
| T1 | Übernahme einer frisch gestarteten Instanz | Setup-Code nur im Log, nur als Hash gespeichert, je Neustart neu, gedrosselt (5 je 5 min je IP, 20 je h global) | umgesetzt (4.3) |
| T2 | Passwort-Raten, Credential Stuffing | Argon2id (19 MiB, t=2), Liste häufiger Passwörter, Backoff je Konto ab 5 Fehlversuchen, 20 Fehlversuche je IP in 10 min, 2FA-Pflicht | umgesetzt (4.3) |
| T3 | Sitzungsdiebstahl | `__Host-rxf_session` (`HttpOnly`, `Secure`, `SameSite=Lax`), nur Hash in der DB, Rotation bei Login und 2FA, 12 h Leerlauf / 7 Tage absolut, Sitzungsliste mit „überall abmelden“, Live-Stream endet mit der Sitzung | umgesetzt (4.3, 4.4b, 4.5a) |
| T4 | CSRF | Synchronizer-Token `X-CSRF-Token`, `Sec-Fetch-Site`/`Origin` gegen `Host` | umgesetzt (4.3) |
| T5 | XSS → Sitzung/Aktionen | strikte CSP ohne `unsafe-inline` mit `require-trusted-types-for 'script'` (Caddy); React-Escaping; kein `dangerouslySetInnerHTML`; e2e schlägt bei jedem CSP-Verstoß fehl | umgesetzt (4.5, 4.6) |
| T6 | Rechteausweitung | jede Route deklariert Rolle, 2FA, CSRF und Re-Auth, sonst startet der Server nicht (Default deny, getestet) | umgesetzt; Aktionen je Instanz folgen mit dem Aktions-Framework (Phase 5) |
| T7 | Gefährliche Aktion durch alte Sitzung | Re-Auth-Fenster 10 min für Instanzen anlegen und löschen, Ziele und Secrets ändern, Backup-Codes und zweiten Faktor ändern | umgesetzt; Aktionen mit `risk: high` und Kontenverwaltung folgen |
| T8 | SSRF ins LAN | Ziel-Allowlist je Instanz, Prüfung der aufgelösten IP gegen Loopback/Link-Local/eigene Adressen (auch gegen DNS-Rebinding), keine Redirects, Ziele nur für Admins mit Re-Auth | umgesetzt (4.4a) |
| T9 | Zu weite Geräte-Rechte | Request-Allowlist (Methode + Pfad) für Collectors, kodierte Separatoren abgelehnt | teilweise: Allowlists für Aktionen und Audit-Einträge bei Verstößen folgen mit dem Aktions-Framework |
| T10 | MITM zu selbstsignierten Geräten | TLS-Modi `system`, `pin-leaf`, `pin-spki`, `ca`; der Pin wird vor dem ersten Byte geprüft; TOFU-Dialog im Onboarding | teilweise: Collectors stoppen und Alarm „Zertifikat geändert“ kommen mit den Alarmen (Phase 7) |
| T11 | Secret-Leck über Backup, Logs, Fehler | AES-256-GCM mit Bindung an Instanz/Feld/Schlüssel, Master-Schlüssel getrennt (Docker-Secret), Redaction in Logs und Audit, Tests auf Lecks | umgesetzt; `rxf rotate-key` folgt |
| T12 | Kompromittierte Abhängigkeit | Lockfile + `--frozen-lockfile`, Install-Skripte nur per Allowlist, osv-scanner, Trivy, Actions auf SHA gepinnt, signierte Images (cosign) | umgesetzt; Dependabot greift ab dem Umstieg auf `main` |
| T13 | Container-Ausbruch | non-root (UID 10001), read-only, `cap_drop: ALL`, `no-new-privileges`, kein Docker-Socket, Speicherlimits | umgesetzt (4.6) |
| T14 | Docker-API als root-Äquivalent | nur über socket-proxy, LAN + Proxmox-Firewall | offen: Docker-Plugin (Phase 5, Welle 2) |
| T15 | Abfluss personenbezogener Daten | keine Telemetrie, nichts davon im Log; Sichtbarkeit je Rolle | teilweise: Sichtbarkeit je Rolle kommt mit dem ersten Plugin, das solche Daten liefert |
| T16 | Selbst-Aussperren durch Aktionen | Aktions-Flag `cutsAccess` mit Warnung | offen: Aktions-Framework |

Weitere Schutzmaßnahmen aus Phase 4:

- Client-IP: `CF-Connecting-IP` gilt nur von cloudflared (CT 110), der Server glaubt `X-Forwarded-For`
  nur von Caddy.
- Pull-Deploy: Das Deploy-Skript prüft die cosign-Signatur gegen den Workflow, zieht per Digest und rollt
  bei einem Fehler zurück.
- Tägliches Backup per `VACUUM INTO` (14 Tage).

## Akzeptierte Befunde

| Befund | Wo | Gültig bis | Begründung |
|---|---|---|---|
| GHSA-fc5q-39xc-vjpf (picomatch ReDoS) | `osv-scanner.toml` | 17.12.2026 | nur Dev-/Build-Werkzeuge, Muster aus eigener Konfiguration |
| CVE-2026-78661 (golang.org/x/net/html DoS) | `.trivyignore.yaml` | 19.12.2026 | im Caddy-Binary; Caddy verarbeitet bei uns kein HTML; kein Caddy-Release mit Fix |

Läuft ein Eintrag ab, wird der jeweilige CI-Job wieder rot.

## ASVS 5 (Level 2), Stand je Kapitel

| Kapitel | Stand | Belege / offen |
|---|---|---|
| V1 Encoding and Sanitization | umgesetzt | React-Escaping, parametrisierte SQL-Abfragen (drizzle, gebundene Parameter), keine Template-Engine |
| V2 Validation and Business Logic | umgesetzt | zod-Schemas für jede Route und jeden Schnappschuss; Fehler nennen Pfade, keine Werte |
| V3 Web Frontend Security | umgesetzt | CSP, Trusted Types, HSTS, `X-Content-Type-Options`, COOP/CORP, `frame-ancestors 'none'`, `__Host-`-Cookie |
| V4 API and Web Service | umgesetzt | JSON-only, einheitliches Fehlerformat, `Cache-Control: no-store`, Antworten gegen Schemas serialisiert |
| V5 File Handling | nicht anwendbar | keine Uploads; der Import/Export von Boards (Phase 6) wird hier nachgetragen |
| V6 Authentication | umgesetzt | Argon2id, Längen- und Listenprüfung, Backoff, TOTP mit Replay-Schutz, Backup-Codes; Passkeys (4.7) |
| V7 Session Management | umgesetzt | 256-Bit-Token, Hash in DB, Rotation, Timeouts, Widerruf, Re-Auth-Fenster |
| V8 Authorization | umgesetzt | Default deny je Route, Rollen nur serverseitig; Aktionsrechte je Instanz folgen |
| V9 Self-contained Tokens | nicht anwendbar | keine JWTs |
| V10 OAuth and OIDC | später | Tailscale-Plugin als OAuth-Client (Phase 5) |
| V11 Cryptography | umgesetzt | AES-256-GCM (`node:crypto`), zufällige IVs, Schlüssel-ID; Rotation folgt |
| V12 Secure Communication | umgesetzt | TLS endet bei Cloudflare; zu Geräten TLS mit Pinning; kein globales Abschalten der Prüfung |
| V13 Configuration | umgesetzt | Secrets nie in ENV (Produktion), Header zentral, keine Debug-Endpunkte, Images gehärtet |
| V14 Data Protection | teilweise | Secrets verschlüsselt, Backups ohne Schlüssel wertlos; Aufbewahrung personenbezogener Daten folgt mit den Plugins |
| V15 Secure Coding and Architecture | umgesetzt | Abhängigkeiten nur mit Freigabe, Lieferkette (T12), Plugins nur aus dem Repo mit Review |
| V16 Security Logging and Error Handling | umgesetzt | persistentes Audit-Log ohne Secrets, strukturierte Logs mit Redaction, generische 500er |
| V17 WebRTC | nicht anwendbar | – |

Die Prüfung je Einzelanforderung mit Nachweis folgt in Phase 8.
