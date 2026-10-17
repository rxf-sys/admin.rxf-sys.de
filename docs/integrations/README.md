# Integrationen – Übersicht (Phase 1)

> Stand: 17.10.2026 · Grundlage: Altcode (`backend/app/clients/*` u. a.) und
> Herstellerquellen. Herstellerseiten waren aus der Analyse-Umgebung per DNS
> gesperrt; geprüft wurde deshalb gegen Quellcode, OpenAPI-Specs und
> Doku-Quellen der Hersteller auf GitHub, ergänzt um Websuche.
>
> Quellenmarken in allen Dateien: **[D]** Primärquelle geöffnet ·
> **[A]** Altcode (`pfad:zeile`) · **[S]** nur über Websuche bestätigt ·
> **[?]** unbestätigt. UniFi und FRITZ!Box nutzen zusätzlich **[D\*]** für
> gepflegte Sekundärquellen (Bibliotheken, Integrationen, Spec-Spiegel).
> Für FRITZ!Box gibt es keine [D]-Angaben: AVM-Dokumente waren nur über
> Suchtreffer erreichbar.

## Dateien

| Plugin-ID | Datei | Altintegration |
|---|---|---|
| `uptime` | [uptime.md](uptime.md) | ja (`probes.py`, `geoip.py`, `storage.py`) |
| `proxmox-ve` | [proxmox-ve.md](proxmox-ve.md) | ja (`proxmox.py`) |
| `proxmox-backup-server` | [proxmox-backup-server.md](proxmox-backup-server.md) | ja (`pbs.py`) |
| `cloudflare` | [cloudflare.md](cloudflare.md) | ja (`cloudflare.py`) |
| `unifi-network` | [unifi-network.md](unifi-network.md) | ja (`unifi.py`, `unifi_remote.py`) |
| `fritzbox` | [fritzbox.md](fritzbox.md) | nein |
| `docker` | [docker.md](docker.md) | nein |
| `tailscale` | [tailscale.md](tailscale.md) | nein |
| `pihole`, `adguard-home` | [pihole-adguard.md](pihole-adguard.md) | nein |
| `home-assistant` | [home-assistant.md](home-assistant.md) | nein |

Kern-Themen außerhalb der Integrationen (Auth, Audit, Benachrichtigungen,
Migration der Konfiguration) stehen in
[`docs/analysis/legacy-core.md`](../analysis/legacy-core.md).

## Gesamtmatrix

| Plugin | Kategorie | API & Auth | Rechte: nur lesen | Rechte: zusätzlich für Aktionen | MVP-Aktionen (Risiko) | Limits / Last | Aufwand | Welle |
|---|---|---|---|---|---|---|---|---|
| `uptime` | Monitoring | eigene Checks: HTTP(S), TCP, ICMP, DNS, TLS | – | – | jetzt prüfen, pausieren (low); Zertifikat neu vertrauen (medium, admin) | Selbstbegrenzung; ICMP braucht `net.ipv4.ping_group_range` im Compose | L | 1 |
| `proxmox-ve` | Virtualisierung | REST `:8006`, `PVEAPIToken=user@realm!id=secret` | `PVEAuditor` auf `/` für Benutzer **und** Token | eigene Rolle mit `VM.PowerMgmt`; `VM.Snapshot` (erlaubt auch Löschen/Rollback) | Start (low), Shutdown/Reboot (medium), Stop (high, admin), Snapshot (low/medium) | kein dokumentiertes Limit; Daten nur alle 10 s neu | L | 1 |
| `proxmox-backup-server` | Backup | REST `:8007`, `PBSAPIToken=user@realm!id:secret` | `DatastoreAudit` auf `/datastore/<store>` + `Audit` auf `/system/tasks` | Verify bräuchte `DatastoreReader` (liest **alle** Backup-Inhalte) → nicht empfohlen | Verify (low), standardmäßig nicht angeboten | kein Limit; `snapshots` teuer | M | 1 |
| `cloudflare` | DNS/Edge | Cloud-REST + GraphQL, `Bearer`-Token | Account: `Cloudflare Tunnel Read`; Zone: `Zone`/`DNS`/`Analytics`/`SSL and Certificates Read` | `Cache Purge`, empfohlen als zweites Token | Cache leeren (low) | 1.200 Req/5 min je Token, GraphQL 300/5 min | M | 1 |
| `unifi-network` | Netzwerk | Integration API `X-API-KEY`; Legacy `stat/health` mit demselben Key; optional Site Manager (Cloud) | **kein Scope-Modell**: Key = Rechte des Admins → Allowlist im Plugin | keine (Key kann schon alles) | AP/Switch-Neustart (medium), Gateway-Neustart (high), PoE-Cycle (high) | lokal keine dokumentiert; Site Manager 10.000/min | M | 1 |
| `fritzbox` | Router | TR-064 (SOAP, Digest, `:49443`) + AHA-HTTP (Session-ID, PBKDF2) für Smart Home | eigener Benutzer mit „FRITZ!Box Einstellungen“ (nicht in lesen/schreiben trennbar → Allowlist im Plugin); optional „Smart Home“, „…Anrufliste“ | keine weiteren (Recht deckt Reboot/Reconnect schon ab) | Gast-WLAN (medium), Steckdose (medium), Reconnect (high, admin), Neustart (high, admin) | Box schwach: max. eine Anfrage gleichzeitig, 30 s aktiv; Login-Sperre wächst bei Fehlversuchen | L | 2 |
| `docker` | Container | Engine API über **linuxserver/socket-proxy** (ohne Auth/TLS, Schutz nur übers Netz) | `CONTAINERS=1`, `INFO=1` (+ `ALLOW_LOGS=1` für Log-Auszug) | `ALLOW_RESTARTS=1` (gibt technisch auch Stop/Kill frei) | Neustart (medium; Infrastruktur-Container high, standardmäßig gesperrt) | keine; Stats je Container teuer | M | 2 |
| `tailscale` | Netzwerk | Cloud-API v2, OAuth Client Credentials (1-h-Token) | Scope `devices:core:read` | zweiter OAuth-Client mit `devices:core` + Tag | Gerät autorisieren, Key-Ablauf aus (low, admin) | nicht dokumentiert | S | 2 |
| `pihole` | DNS/Edge | REST `/api`, Session per App-Passwort | kein Read-only (App-Passwort ohne `app_sudo` ändert keine Config) | – | Blocking pausieren (low), dauerhaft aus (medium, admin) | max. 16 Sessions → eine geteilte Session | M (mit Kit) | 2 |
| `adguard-home` | DNS/Edge | `/control`, Login-Cookie | **kein Rechtemodell**: jeder Benutzer ist Admin | – | Schutz pausieren (low), dauerhaft aus (medium, admin) | Login-Sperre 5 Fehlversuche/15 min | S | 2 |
| `home-assistant` | Smart Home | REST + WebSocket, Long-Lived Token | **keine Scopes**: dedizierter Nicht-Admin + Allowlist im Plugin | – | Entitäten schalten nach Allowlist (low bis high je Domain) | – (WebSocket statt Polling) | L | 2 |

## Vorschlag: Reihenfolge in Phase 5

**Grundgerüst (Phase 4):** `uptime` mit HTTP-Check Ende-zu-Ende. Das Plugin
braucht keinen externen Dienst und ist damit die Referenz für das SDK
(Schema, `test()`, Collector, Metric, Widget). Die übrigen Check-Typen folgen
in Welle 1.

**Welle 1 – vorhandene Integrationen** (Ersatz für die Live-App, Grundlage für den Umstieg):

1. `uptime` vollständig (inkl. Import der Probe-Historie)
2. `proxmox-ve` (baut TLS-Pinning und asynchrone Aktionen, die PBS mitnutzt)
3. `proxmox-backup-server`
4. `cloudflare`
5. `unifi-network`

**Welle 2 – neue Integrationen** (nach Reihenfolge der SDK-Bausteine):

1. `docker` (lokal voll testbar, sofort Nutzen für CT 110)
2. `tailscale` (validiert den Cloud-/OAuth-Pfad)
3. `fritzbox` (Kern zuerst: Internet, Gast-WLAN; Smart Home und Anrufliste als Teilmodule)
4. `home-assistant` (braucht Stream-Collector und Options-Provider)
5. `pihole` + `adguard-home` mit gemeinsamem `dns-filter-kit` (zuletzt, weil derzeit kein DNS-Filter läuft)

Aufwand gesamt: L × 4 (`uptime`, `proxmox-ve`, `fritzbox`, `home-assistant`),
M × 5 (`proxmox-backup-server`, `cloudflare`, `unifi-network`, `docker`,
`pihole` + Kit), S × 2 (`tailscale`, `adguard-home`).

Begründung: Welle 1 deckt alles ab, was die alte App heute kann. Damit ist
der Umstieg (Phase 9) nach Welle 1 möglich, unabhängig vom Fortschritt in
Welle 2.

## Querschnitt: Anforderungen an das Plugin-SDK (Input für Phase 2)

Die Analyse zeigt Bausteine, die mehrere Plugins brauchen. Sie gehören ins
SDK, nicht in einzelne Plugins:

| Baustein | Gebraucht von | Kern der Anforderung |
|---|---|---|
| **TLS-Pinning** | PVE, PBS, UniFi, Pi-hole, FRITZ!Box, HA, Docker (mTLS-Variante), Uptime | Modi Leaf-Fingerprint, SPKI und eigene CA. Pin ersetzt die Hostnamen-Prüfung (Pi-hole-Zertifikat lautet immer auf `pi.hole`). Mehrere Pins je Instanz (PVE-Cluster). Auch für WebSocket. |
| **Request-Allowlist je Plugin** | UniFi, FRITZ!Box, AdGuard Home, Home Assistant, Docker | Viele Credentials können mehr als nötig. Das SDK erzwingt pro Plugin erlaubte Methoden und Pfade, getrennt für Collectors (nur lesen) und Aktionen. |
| **Getrennte Aktions-Credentials** | Cloudflare, Tailscale | Optionales zweites Secret nur für Aktionen; Widerruf schaltet Aktionen ab. |
| **Rechte-Selbstdiagnose in `test()`** | PVE, PBS, Cloudflare, Docker | Ergebnis pro Fähigkeit (ok / fehlt / zu viel), Teil-Erfolg möglich. Docker prüft aktiv, ob der Endpunkt **zu viel** erlaubt. |
| **Asynchrone Aktionen** | PVE, PBS, Pi-hole (Gravity) | Aktion startet einen Task (UPID), Fortschritt per Polling, Ergebnis ins Audit-Log. Laufzeit bis Minuten. |
| **Stream-Collectors** | Docker (`/events`), Home Assistant (WebSocket) | Dauerverbindung mit Reconnect neben dem Polling. |
| **Session-Verwaltung** | Pi-hole (Seats), AdGuard Home, FRITZ!Box (AHA-SID) | einmal anmelden, Mutex beim Login, ein Re-Login bei 401, Abmelden beim Stop. |
| **OAuth-Token-Cache** | Tailscale | Client-Credentials-Flow, Erneuerung vor Ablauf. |
| **Options-Provider im Formular** | HA (Entitäten), PBS (Datastores), Cloudflare (Zonen), UniFi (Sites) | Formularfeld lädt Auswahlwerte live vom Gerät. |
| **Plugin-übergreifende Verknüpfungen** | PBS ↔ PVE, Cloudflare-Ingress → Uptime-Checks, Docker ↔ PVE-Gast, Tailscale ↔ Host | Verknüpfung über Entitäten, ohne harte Abhängigkeit zwischen Plugins. |
| **Rate-Limit-Steuerung** | Cloudflare, UniFi Site Manager | `Ratelimit`/`Retry-After` auswerten, Frequenz automatisch senken. |
| **Warnung „trennt Dashboard-Zugang“** | UniFi (Gateway, PoE), FRITZ!Box (Neustart, Reconnect), Docker (`cloudflared`) | eigenes Flag an der Aktion zusätzlich zur Risikostufe, im Bestätigungsdialog sichtbar. |
| **Single-Flight-Queue je Gerät** | FRITZ!Box, PVE-Agent-Abfragen | höchstens eine laufende Anfrage pro schwachem Gerät, Collector-Läufe nie parallel. |
| **Stabile Entitäts-IDs** | Docker (ID wechselt bei Neuerstellung), UniFi (MAC über drei APIs) | `externalId` aus stabilen Merkmalen bilden, technische IDs nur als Attribut. |

## Fehler und Mängel im Altcode (bei der Analyse gefunden)

v1 läuft bis zum Umstieg weiter. Die Punkte werden in v2 vermieden; in v1
werden sie nur behoben, wenn du das willst.

| Bereich | Befund | Fundstelle | Wirkung heute |
|---|---|---|---|
| Betrieb | Backup-Befehl in `CLAUDE.md` sichert `/data/probes.db`; die echte Datenbank ist `/data/rxf-admin.db` | `CLAUDE.md:106-107` vs. `backend/app/config.py:142`, `docs/SETUP.md` §8 | Ein nach `CLAUDE.md` eingerichteter Cronjob sichert nichts. `docs/SETUP.md` ist korrekt. |
| Probes | Uptime-Historie wird nach 7 Tagen gelöscht | `backend/app/config.py:145` | Beim Umstieg kommt nur eine Woche Historie mit (siehe Empfehlung unten) |
| Probes | „30-Tage-Uptime“ rechnet über 720 h, Daten reichen aber nur 7 Tage | `backend/app/routers/services.py:50` | Anzeige ist faktisch eine 7-Tage-Uptime |
| Probes | Jeder HTTP-Status < 500 gilt als „up“, auch 404 | `backend/app/clients/probes.py:79` | Fehlkonfigurierte Dienste erscheinen grün |
| UniFi | WAN-Durchsatz aus falschen Feldnamen (`rx-bytes-r` statt `rx_bytes-r`, `xput_*` im falschen Subsystem) | `backend/app/clients/unifi.py:468-471, 541-552` | Live-Durchsatz vermutlich immer 0 |
| UniFi | CPU/RAM aus dem Geräte-Detail statt aus `statistics/latest` | `backend/app/clients/unifi.py:153-217` | Werte nur über Cookie-Anreicherung |
| Cloudflare | cloudflared-Version aus falschem Feld | `backend/app/clients/cloudflare.py:143` | Versionsanzeige vermutlich leer |
| Cloudflare / GeoIP | WAN-IP über `api.ipify.org`, ISP über `ipapi.co` | `backend/app/clients/cloudflare.py:156-163`, `backend/app/clients/geoip.py` | WAN-IP geht an Drittanbieter |
| PVE | Laut `docs/SETUP.md` bekommt nur der Benutzer die ACL, obwohl Privilege Separation an ist | `docs/SETUP.md:45-58` | Ein so angelegtes Token hätte keine Rechte (Live-Setup weicht vermutlich ab) |
| PBS | `docs/SETUP.md` empfiehlt eine eigene Rolle mit `Datastore.Verify`; PBS kennt keine eigenen Rollen | `docs/SETUP.md:71-81` | Anleitung nicht umsetzbar |
| PVE | Eigene Metrik-Samples statt `rrddata`; LXC-IP nur aus statischer Config (kein DHCP) | `backend/app/routers/system.py:145`, `backend/app/clients/proxmox.py:155-163` | doppelte Last, fehlende IPs |

## Empfehlungen, die nur du umsetzen kannst

1. **Probe-Historie vor dem Umstieg verlängern:** In der Live-`.env` auf CT 110
   `HISTORY_RETENTION_DAYS` z. B. auf `90` setzen und neu starten. Bei 8
   Diensten sind das ca. 2 Mio. Zeilen, für SQLite unkritisch. Ohne diese
   Änderung übernimmt v2 nur die letzte Woche.
2. **SQLite-Backup prüfen:** Falls der Cronjob nach `CLAUDE.md` eingerichtet
   wurde, sichert er die falsche Datei. Die Variante aus `docs/SETUP.md` §8
   ist korrekt.

## Offene Fragen

Gesammelt aus allen Dateien. Die architekturrelevanten Fragen sind
beantwortet; die übrigen klären wir im jeweiligen Plugin-PR.

### Entschieden am 17.10.2026 (vor Phase 2)

| Frage | Entscheidung | Folge |
|---|---|---|
| Altfunktionen ohne Platz im v2-Auftrag (API-Bearer-Tokens, Host-Audit, Wochenreport) | **entfallen alle drei** | keine Migration der Tabellen `api_tokens`, `audit_runs` und der Report-Einstellungen |
| Absicherung des Docker-Socket-Proxys auf entfernten Hosts | **LAN + Proxmox-Firewall** (Variante B in `docker.md`) | kein mTLS im MVP; v2 auf dem eigenen Host nutzt den Proxy ohne veröffentlichten Port |
| Eingesetzter DNS-Filter | **keiner (noch)** | `pihole` und `adguard-home` bleiben im MVP, rücken aber ans Ende von Welle 2 |
| Dauerhafte WebSocket-Verbindung zu Home Assistant | **ja** | Stream-Collector läuft auch ohne Zuschauer |
| Proxmox VE | **Einzelknoten** | Cluster-Failover bleibt im Design, Testfälle für den Einzelknoten zuerst |
| ICMP im v2-Container | **`net.ipv4.ping_group_range` per Compose-`sysctls` erlaubt** | Variante C + A aus `uptime.md`; Wert im neuen LXC testen |

### Im Plugin-PR

- PVE: Snapshot-Aktion trotz `VM.Snapshot` (erlaubt auch Löschen/Rollback)? Harter Stop nur admin?
- PBS: Verify-Aktion mit `DatastoreReader` oder nur geplante Verify-Jobs anzeigen? Schwelle „überfällig“ 26 h passend?
- Cloudflare: getrenntes Purge-Token? Account-owned Token?
- FRITZ!Box: Router oder Modem vor dem UCG Ultra? Modell, FRITZ!OS-Version, Zugangsart (DSL/Kabel/Glasfaser)?
- UniFi: PoE-Cycle immer `high`? Kann ein „View Only“-Admin einen lokalen Key erzeugen (Test auf der UCG Ultra)?
- Docker: Welche Container dürfen neu gestartet werden? Logs auch für `viewer`?
- Tailscale: Tags und Geräte-Freigabe im Einsatz? Welcher Plan?
- Pi-hole/AdGuard: maximale Pausendauer, dauerhaftes Abschalten erlaubt?
- Home Assistant: Welche Entitäten sichtbar, welche schaltbar? FRITZ!DECT über HA oder über das FRITZ!Box-Plugin?
- Uptime: Default für erwartete HTTP-Statuscodes (streng oder wie bisher `< 500`)? Verwaiste Einträge beim Import übernehmen?
