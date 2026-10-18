# ADR 0008 – Sicherheitsmodell

- **Status:** Akzeptiert (18.10.2026)
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §8; `docs/analysis/legacy-core.md` §2–3; `docs/integrations/README.md` (Querschnitt); ADR 0003, 0005, 0006

## Kontext

Das Dashboard hält Zugangsdaten zu Hypervisor, Backup, Router, DNS, Tunnel
und Smart Home und kann dort Aktionen auslösen. Es ist über Cloudflare
Tunnel aus dem Internet erreichbar. Eine Übernahme wäre eine Übernahme der
gesamten Heim-Infrastruktur. Die Analyse zeigt außerdem: Viele Geräte
kennen keine Nur-Lese-Rechte (UniFi-Key, FRITZ!Box-„Einstellungen“,
AdGuard Home, Home Assistant).

## Bedrohungen und Gegenmaßnahmen

| # | Bedrohung | Gegenmaßnahme | ADR |
|---|---|---|---|
| T1 | Übernahme einer frisch gestarteten Instanz | Setup-Code nur im Log, 24 h gültig, gedrosselt | 0005 |
| T2 | Passwort-Raten, Credential Stuffing | Argon2id, Backoff je Konto, Drossel je IP, 2FA-Pflicht | 0005 |
| T3 | Sitzungsdiebstahl | `__Host-`-Cookie `HttpOnly`/`Secure`/`SameSite=Lax`, Hash in DB, Rotation, Leerlauf-Timeout, „überall abmelden“ | 0005 |
| T4 | CSRF | Synchronizer-Token + `Origin`/`Sec-Fetch-Site`-Prüfung | 0005 |
| T5 | XSS → Sitzung/Aktionen | strikte CSP (s. u.), React-Escaping, kein `dangerouslySetInnerHTML` (Biome-Regel), Trusted Types | – |
| T6 | Rechteausweitung (viewer → Aktion) | Default-deny-Routendeklaration, Rollen nur serverseitig, Aktionen je Instanz opt-in | 0005, 0003 |
| T7 | Gefährliche Aktion durch übernommene, aber „alte“ Sitzung | Re-Auth-Fenster 10 min für `risk: high`, Secrets, Ziele, Konten | 0005 |
| T8 | SSRF: Dashboard als Sprungbrett ins LAN | Ziel-Allowlist je Instanz, nur Admins ändern Ziele, Sperrliste, keine Redirects auf fremde Hosts | hier |
| T9 | Zu weite Geräte-Rechte werden ausgenutzt | Request-Allowlist je Plugin, getrennt für Collectors und Aktionen | hier, 0003 |
| T10 | MITM zu selbstsignierten Geräten | TLS-Pinning (TOFU), nie globales Abschalten der Prüfung | hier |
| T11 | Secret-Leck über DB-Backup, Logs, Fehlermeldungen | AES-256-GCM, Schlüssel getrennt, Redaction, Tests auf Lecks | 0006 |
| T12 | Kompromittierte Abhängigkeit | Lockfile, `--frozen-lockfile`, Install-Skripte nur per Allowlist, osv-scanner, Trivy, Dependabot, gepinnte Actions | hier, 0009 |
| T13 | Container-Ausbruch / Host-Übernahme | non-root, read-only, `cap_drop: ALL`, `no-new-privileges`, kein Docker-Socket | hier, 0009 |
| T14 | Docker-API als root-Äquivalent | nur über linuxserver/socket-proxy, LAN + Proxmox-Firewall (Owner-Entscheidung 17.10.2026), Gegenprobe auf zu weite Rechte | `docker.md` |
| T15 | Abfluss personenbezogener Daten (Anrufliste, Hostnamen) | rollenbasierte Sichtbarkeit, keine Telemetrie, nichts davon im Log | hier |
| T16 | Selbst-Aussperren durch Aktionen | Aktions-Flag `cutsAccess`, Warnung im Dialog, standardmäßig `admin` | 0003 |

## Entscheidungen im Einzelnen

### SSRF-Schutz (T8)

- Jede Instanz liefert über `targets(config)` die erlaubten Ziele
  (`scheme://host:port`). Der SDK-HTTP-Client (undici-Agent je Instanz)
  verweigert alle anderen Ziele, bevor eine Verbindung aufgebaut wird.
- Ziele (Host, Port, URL) sind `adminOnly`-Felder und verlangen Re-Auth.
- Sperrliste ohne ausdrückliche Freigabe: Loopback, Link-Local
  (`169.254.0.0/16`, `fe80::/10`) inklusive Metadaten-Adressen, die eigene
  Container-IP. Geprüft wird die **aufgelöste** IP beim Verbindungsaufbau
  (Schutz gegen DNS-Rebinding auf diese Bereiche).
- Redirects werden nicht verfolgt, außer innerhalb desselben erlaubten
  Ziels.
- Das Uptime-Plugin prüft frei wählbare Ziele; deshalb dürfen nur Admins
  Checks anlegen (`docs/integrations/uptime.md`).

### Request-Allowlist (T9)

- Jedes Plugin deklariert erlaubte Anfragen als Methode + Pfadmuster,
  getrennt in `collect` und `action` (ADR 0003). Collectors erhalten einen
  Client, der nur `collect`-Muster kennt; Aktionen einen Client mit genau
  den Mustern der jeweiligen Aktion.
- Beispiele: UniFi erlaubt `POST` nur auf `…/devices/{id}/actions` mit
  Body-Allowlist `RESTART`; FRITZ!Box erlaubt nur gelistete SOAP-Actions;
  Home Assistant nur freigegebene `domain.service` für freigegebene
  Entitäten.
- Verstöße werden nicht ausgeführt, als Fehler gemeldet und im Audit-Log
  vermerkt (deutet auf einen Plugin-Fehler hin).

### TLS-Pinning (T10)

- Modi je Ziel: `system` (öffentliche CA), `pin-leaf` (SHA-256 des
  Zertifikats), `pin-spki` (SHA-256 des öffentlichen Schlüssels), `ca`
  (eigene CA als PEM).
- Bei Pins ersetzt der Pin die Hostnamenprüfung (Pi-hole-Zertifikat lautet
  immer auf `pi.hole`, Geräte werden per IP angesprochen).
- Ablauf: `test()` zeigt Fingerprint, Aussteller, SAN, Ablauf → Admin
  bestätigt → Pin gespeichert. Bei Abweichung: Instanz geht auf Fehler,
  Collectors stoppen, Alarm „Zertifikat geändert“; neu vertrauen nur durch
  einen Admin mit Re-Auth, alter und neuer Fingerprint landen im Audit-Log.
- Gilt auch für WebSocket-Verbindungen (Home Assistant).

### Web-Schutz (T4, T5)

Header, ausgeliefert von Caddy:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none';
  require-trusted-types-for 'script'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

- Schriften werden selbst gehostet (keine Google-Fonts-Ausnahme wie im
  Altcode).
- Bibliotheken, die zur Laufzeit `<style>`-Elemente einfügen (z. B.
  Toasts), werden über einen beim Build berechneten `'sha256-…'`-Hash in
  `style-src` erlaubt, nicht über `'unsafe-inline'`. Der Auftrag verlangt
  `unsafe-inline`-Freiheit nur für Scripts; für Styles ist das unser
  Zusatzziel. Ein Playwright-Test schlägt bei CSP-Verstößen fehl.

### Container und Host (T13)

- Images: Multi-Stage, Laufzeit non-root (UID 10001), read-only
  Root-Dateisystem, `tmpfs` für `/tmp`, nur `/data` beschreibbar,
  `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
  `net.ipv4.ping_group_range` per `sysctls` (Owner-Entscheidung
  17.10.2026), Healthcheck, Speicherlimit.
- Kein Docker-Socket im Container.
- Ausgehend: nur konfigurierte Ziele. Keine Telemetrie, keine Update-Checks
  nach außen.

### Lieferkette (T12)

- `pnpm install --frozen-lockfile`; pnpm führt Install-Skripte nur für
  ausdrücklich freigegebene Pakete aus (Allowlist in der pnpm-Konfiguration,
  z. B. `better-sqlite3`).
- CI: osv-scanner auf das Lockfile, Trivy auf die Images, Dependabot für
  npm, GitHub Actions und Docker; alle Actions auf Commit-SHA gepinnt,
  `permissions: contents: read` als Standard (Lehre #12).
- Neue Abhängigkeiten nur mit Owner-Freigabe (Auftrag §3).

### Plugin-Vertrauensmodell

Plugins laufen im selben Prozess ohne Sandbox. Deshalb gibt es nur
erstanbieterische Plugins aus dem Monorepo, jedes mit Review und
`security-review` vor dem Merge. Ein Nachladen fremder Plugins zur Laufzeit
ist bewusst nicht vorgesehen (ADR 0003).

### Personenbezogene Daten (T15)

Anrufliste, Hostnamen, Client-Listen und Logs sind personenbezogen.
Sichtbarkeit je Rolle konfigurierbar (Standard: Anrufliste nur `operator`+),
nie im Log, Aufbewahrung begrenzt.

## Folgen

- `docs/SECURITY.md` (Phase 4) übernimmt diese Tabelle als lebendes
  Dokument mit ASVS-Checkliste und Meldeweg für Sicherheitslücken.
- Jeder PR, der Auth, Secrets, Ziele oder Aktionen berührt, bekommt einen
  `security-review` (Auftrag §8).
- Phase 8 prüft jede Zeile der Tabelle mit einem Test oder einer
  dokumentierten manuellen Prüfung.
