# ADR 0001 – Kickoff-Entscheidungen für admin.rxf-sys.de v2

- **Status:** Akzeptiert
- **Datum:** 17.10.2026
- **Entscheider:** Repo-Owner (Kickoff-Fragen), vorbereitet von Claude

## Kontext

Das bestehende Admin-Dashboard (FastAPI + SQLite, React/Vite) wird vollständig
durch ein modulares Infrastruktur-Dashboard mit Plugins ersetzt. Integrationen
sind heute fest verdrahtet und per ENV konfiguriert (`backend/app/clients/*`).
Vor Architektur und Design müssen sechs Grundsatzfragen geklärt sein
(Auftrag, Abschnitt 4). Dieses ADR hält die Antworten fest; die technischen
Details folgen in den ADRs aus Phase 2.

## Entscheidungen

### 1. Nutzermodell

| Option | Bewertung |
|---|---|
| Nur ich | minimal, Rollenmodell ungenutzt |
| **Haushalt mit Rollen** | **gewählt** |
| Mehrere unabhängige Nutzer (Multi-Tenant) | Datenisolation in jeder Abfrage, pro Tenant eigene Secrets und Sammler |

**Entscheidung:** Eine Instanz, eine gemeinsame Infrastruktur, mehrere Konten
mit den Rollen `admin`, `operator`, `viewer` (Auftrag 5.5). Plugins, Secrets
und Sammler gehören der Instanz; Dashboards/Boards gehören dem einzelnen
Nutzer.

### 2. Tech-Stack

| Option | Bewertung |
|---|---|
| **TypeScript-Monorepo** (Node 22, Fastify, Zod, Drizzle/SQLite, React 19) | **gewählt** |
| Python/FastAPI beibehalten | Clients direkt übernehmbar, aber kein geteiltes Schema zwischen Server und Web |

**Entscheidung:** TypeScript-Monorepo nach Empfehlung aus Abschnitt 7. Ein
Zod-Schema pro Plugin erzeugt Formular, Validierung und Typen in Server und
Web. Die Detailauswahl (Auth-Bibliothek, Styling, Diagramme usw.) wird in
Phase 2 per eigenem ADR und Dependency-Tabelle entschieden.

### 3. Design

| Option | Bewertung |
|---|---|
| **Signal, dark-first** | **gewählt** |
| Signal, light-first | – |
| Eigene Identität (dark- oder light-first) | – |

**Entscheidung:** Das Designsystem „Signal“ (www.rxf-sys.de) ist die Basis
und wird für dichte Ops-Ansichten erweitert (Tabellen, Widgets, Statusfarben).
Das dunkle Theme wird zuerst gestaltet, das helle ist gleichwertig
unterstützt. Der Standard folgt `prefers-color-scheme`, der Nutzer kann
umschalten.

### 4. Plugins im MVP

**Entscheidung:** Zehn Plugins im ersten Release.

| Plugin | Status heute |
|---|---|
| Proxmox VE | vorhanden (`clients/proxmox.py`) |
| Proxmox Backup Server | vorhanden (`clients/pbs.py`) |
| Cloudflare | vorhanden (`clients/cloudflare.py`) |
| Uptime/Probes (eingebaut) | vorhanden (`clients/probes.py`, `geoip.py`) |
| UniFi Network | vorhanden (`clients/unifi.py`, `unifi_remote.py`) |
| AVM FRITZ!Box | neu |
| Docker (über Socket-Proxy) | neu |
| Pi-hole v6 / AdGuard Home | neu |
| Tailscale | neu |
| Home Assistant | neu |

**Später:** Synology DSM / TrueNAS, OPNsense, Vulpexa (RMM), Speedtest Tracker.

### 5. Aktionen

| Option | Bewertung |
|---|---|
| **Mit Aktionen, opt-in pro Plugin** | **gewählt** |
| Nur risikoarme Aktionen | – |
| Erst nur lesend | – |

**Entscheidung:** Aktionsvertrag, Audit-Log und Re-Authentifizierung gibt es
ab dem Grundgerüst. Aktionen sind pro Plugin standardmäßig **aus** und werden
im Onboarding-Schritt „Berechtigungen“ oder später in den Einstellungen
bewusst freigeschaltet. Dazu sind getrennte Token-Rechte nötig, die pro
Plugin dokumentiert werden.

### 6. Umstieg

| Option | Bewertung |
|---|---|
| Staging im selben LXC | – |
| **Eigener LXC für v2** | **gewählt** |
| Kein Staging | – |

| Option (Daten) | Bewertung |
|---|---|
| **Konfiguration + Probe-Historie** | **gewählt** |
| zusätzlich Konten | – |
| nur Konfiguration / nichts | – |

**Entscheidung:**
- v2 läuft in einem eigenen Proxmox-LXC, getrennt von CT 110. Die alte App
  bleibt bis zur Abnahme unverändert live.
- Beim Umstieg wird die alte ENV-Konfiguration in Plugin-Konfigurationen
  überführt (Secrets verschlüsselt) und die Probe-Historie in die neuen
  Zeitreihen importiert.
- Konten werden **nicht** übernommen: Das erste Admin-Konto entsteht über den
  Setup-Code, weitere Konten legt der Admin neu an, 2FA/Passkeys werden neu
  eingerichtet.

## Folgen

- **Umfang:** Zehn MVP-Plugins verdoppeln Phase 5 gegenüber dem Vorschlag
  (sieben). Die Fähigkeitsmatrix in Phase 1 zeigt, ob eine Reihenfolge in
  Wellen sinnvoll ist (zuerst die fünf vorhandenen, dann die neuen).
- **Pi-hole und AdGuard Home** haben unterschiedliche APIs. Ob es ein Plugin
  mit zwei Adaptern oder zwei Plugins werden, entscheidet das Plugin-SDK-ADR
  in Phase 2.
- **Rollen:** Die heutige Rolle `user` gibt es nicht mehr. Da keine Konten
  migriert werden, ist kein Mapping nötig.
- **Aktionen opt-in** erfordern im SDK pro Aktion eine Risikostufe, die
  benötigte Rolle und die zusätzlich benötigten Token-Rechte.
- **Eigener LXC:** CT-ID, IP und Tunnel-Hostname (Annahme:
  `admin-next.rxf-sys.de`) werden vor Phase 4 festgelegt. CD per Self-hosted
  Runner wird für diesen LXC neu eingerichtet; der bestehende SSH-Deploy für
  `main`/CT 110 bleibt bis zum Umstieg unangetastet.
- **CI:** Die heutigen Workflows laufen nur für `main`. Der v2-Branch braucht
  eigene Trigger, ohne den CD-Workflow für `main` auszulösen (Phase 4).
