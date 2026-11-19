# ADR 0009 – Betrieb, CI und Deployment

- **Status:** Akzeptiert (18.10.2026): Option B, Pull-Deploy
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §3 (Git und Deploy), §7 (Betrieb), §9; ADR 0001 §6 (eigener LXC); ADR 0008

## Kontext

- `main` wird per CD sofort auf CT 110 deployt (SSH-Action mit Secrets in
  GitHub). Das bleibt bis zum Umstieg unverändert.
- v2 läuft in einem **eigenen LXC** (ADR 0001) und soll von `v2` aus
  automatisch auf Staging (`admin-next.rxf-sys.de`, Annahme) gehen.
- Der Auftrag schlägt einen **Self-hosted Runner im LXC** vor (wie beim RMM).
- **Das Repo ist öffentlich** (geprüft am 17.10.2026). GitHub empfiehlt
  Self-hosted Runner nur für private Repos, weil Workflows aus Pull
  Requests von Forks auf dem Runner Code ausführen können. Gegenmittel
  (Freigabepflicht für Fork-Workflows, Runner-Gruppen mit
  Workflow-Beschränkung, kurzlebige Runner) senken das Risiko, schließen es
  aber nicht aus; Runner-Gruppen mit Workflow-Beschränkung setzen zudem eine
  Organisation mit passendem Plan voraus.
- Die heutigen Workflows laufen nur für `main`.

## Optionen für das Deployment

| Option | Wie | Bewertung |
|---|---|---|
| A – Self-hosted Runner im v2-LXC (Auftrag) | Workflow-Job `runs-on: self-hosted` baut/zieht und startet Compose | einfach, keine Secrets in GitHub; **Risiko durch öffentliches Repo**: Runner im Heimnetz führt Workflow-Code aus |
| **B – Pull-Deploy** | GitHub-gehostete Runner bauen die Images und pushen sie nach GHCR (nur `GITHUB_TOKEN`, signiert per Sigstore/cosign keyless). Ein systemd-Timer im LXC prüft alle 2 min den Digest des Tags `staging`, verifiziert die Signatur gegen die Workflow-Identität dieses Repos, zieht, sichert die DB, startet neu, prüft Health und rollt bei Fehler auf den vorherigen Digest zurück | kein eingehender Zugriff, kein Runner im LAN, keine Deploy-Secrets in GitHub; etwas mehr Einrichtung (Skript + Timer + cosign) |
| C – SSH-Deploy wie heute | GitHub-Action per SSH in den LXC | erprobt, aber SSH-Schlüssel mit Root-Zugang als GitHub-Secret |

## Entscheidung

**Option B (Pull-Deploy)** für Staging und später Produktion. Option A nur,
falls das Repo privat wird.

### Umgebung

- **v2-LXC:** Debian 13, unprivilegiert, `nesting=1,keyctl=1`,
  `firewall=1`, 2 Kerne, 1 GB RAM, 16 GB Disk; CT-ID und IP legt der Owner
  vor Phase 4 fest. Docker CE + Compose-Plugin. Wird per vzdump auf PBS
  gesichert.
- **Compose-Dienste:** `web` (Caddy: liefert das Frontend, proxyt `/api`,
  setzt die Sicherheits-Header aus ADR 0008, `flush_interval -1` für
  `/api/stream`) und `server` (Node 26). Beide non-root, read-only,
  `cap_drop: [ALL]`, Healthchecks (`/healthz`), Speicherlimit `server`
  384 MB (Ziel: < 200 MB bei 5 aktiven Plugins), Volume `rxf-admin-v2-data`
  für `/data`, Master-Schlüssel als Docker-Secret.
- **Netz:** `cloudflared` (CT 104) bekommt einen weiteren Public Hostname
  `admin-next.rxf-sys.de → http://<v2-LXC-IP>:80`. Kein Port nach außen.
  Für das Docker-Plugin öffnet die Proxmox-Firewall der Docker-Hosts Port
  2375 nur für die v2-LXC-IP (ADR 0008, T14).

### CI (neuer Workflow `ci-v2.yml`)

Läuft bei Push und PR auf `v2` (ab dem Umstieg auch `main`). Der
bestehende `ci.yml`/`cd.yml` bleibt unverändert für den Altcode auf `main`.

| Job | Inhalt | Gate |
|---|---|---|
| `install` | pnpm-Cache, `pnpm install --frozen-lockfile` | – |
| `lint` | `biome ci` | Fehler = rot |
| `typecheck` | `tsc --noEmit` (TS 7) für alle Pakete | Fehler = rot |
| `test` | Vitest mit Coverage | Kern ≥ 80 %, je Plugin ≥ 70 % |
| `build` | Server und Web | – |
| `size` | `size-limit` | Entry ≤ 150 KB gz, je Plugin-Chunk ≤ 60 KB gz |
| `isolation` | Vite-Manifest-Prüfung + Playwright „nur `uptime` aktiv“ | kein fremder Plugin-Chunk geladen |
| `e2e` | Playwright mit axe; Screenshots Desktop + 390 px, hell + dunkel als Artefakt | keine axe-Verstöße `serious`/`critical` |
| `knip` | unbenutzte Exporte/Abhängigkeiten | Fehler = rot |
| `osv` | osv-scanner auf `pnpm-lock.yaml` | bekannte Lücke = rot |
| `image` | Docker-Build + Trivy | `HIGH`/`CRITICAL` mit Fix = rot |
| `publish` | nur bei Push auf `v2`: Images nach GHCR, cosign-Signatur, Tag `staging` | – |

Alle Actions auf Commit-SHA gepinnt, `permissions: contents: read` als
Standard, `packages: write` und `id-token: write` nur im Job `publish`.
Keine Secrets in PR-Workflows.

### Branch-Schutz (Einstellung im GitHub-UI durch den Owner)

`v2`: PR-Pflicht, grüne CI-Pflicht, kein Force-Push. `main` bleibt wie heute.

### Betriebsfunktionen im Server

- `/healthz` (Prozess + DB erreichbar), optional `/metrics`.
- Tägliches DB-Backup per `VACUUM INTO` nach `/data/backups/`
  (14 Tage Aufbewahrung) zusätzlich zum vzdump des LXC.
- Strukturierte Logs (pino, JSON) auf stdout.

## Folgen

- Der Owner legt vor Phase 4 an: neuen LXC (CT-ID, IP), Public Hostname im
  Tunnel, Branch-Schutz für `v2`.
- Für Option B entsteht in Phase 4 `infrastructure-v2/` mit Compose-Datei,
  Deploy-Skript, systemd-Unit und -Timer und einer Anleitung in
  `docs/OPERATIONS.md`.
- Die GHCR-Images sind öffentlich (öffentliches Repo); sie enthalten keine
  Secrets.
- `infrastructure/` (Altcode) bleibt bis Phase 9 unverändert.

## Nachtrag: Akzeptierte osv-Befunde (17.11.2026)

- Befunde, die nicht den ausgelieferten Code erreichen und für die es noch keinen Fix gibt,
  können in `osv-scanner.toml` befristet akzeptiert werden. Jeder Eintrag enthält genau eine
  Advisory-ID, eine Begründung und ein Ablaufdatum. Danach ist der Job wieder rot.
- **Erster Eintrag** (Owner-Entscheidung 17.11.2026): `GHSA-fc5q-39xc-vjpf`, ein ReDoS in
  `picomatch` ≤ 4.0.7, gültig bis 17.12.2026.
  - Betroffen sind nur Dev- und Build-Werkzeuge (vite, vitest, knip).
  - Die Glob-Muster stammen aus der eigenen Konfiguration.

## Nachtrag: Umsetzung in Phase 4.6, Vorbereitung (19.11.2026)

Owner-Entscheidung 19.11.2026: 4.6 wird ohne Staging-Daten vorbereitet. Das Ausrollen folgt, sobald
CT-ID, IP und der GHCR-Zugriff feststehen. Anleitung: `docs/OPERATIONS.md`.

- **Images:** `apps/server/Dockerfile` und `apps/web/Dockerfile`, beide mit dem Repo-Root als Kontext.
  - Basis-Images per Digest fixiert: Node 26.12.0 (trixie-slim) und Caddy 2.11.9 (alpine).
  - Der Server bekommt im Image die aktuellen Debian-Sicherheitsupdates (`apt-get upgrade`), weil
    der Trivy-Gate behebbare `HIGH`/`CRITICAL` sonst rot meldet.
  - better-sqlite3 bringt N-API-Binaries mit, ein Compiler ist nicht nötig.
  - Caddy lauscht als UID 10001 auf `:8080`; Compose bildet `80:8080` ab.
- **Client-IP:**
  - Caddy glaubt `CF-Connecting-IP` nur von `RXF_CLOUDFLARED_IP` (`trusted_proxies`,
    `client_ip_headers`).
  - An den Server gibt Caddy genau eine Adresse weiter: `X-Forwarded-For {client_ip}`.
  - Der Server glaubt nur Caddys fester Adresse im Compose-Netz (`RXF_TRUSTED_PROXIES=172.30.10.10`).
  - Lokal geprüft: Eine gefälschte `CF-Connecting-IP` von einem anderen Host wird ignoriert.
- **CSP im Test:**
  - `vite preview` liefert dieselben Header wie Caddy (`apps/web/security-headers.ts`). Ein Test
    vergleicht sie mit dem Caddyfile.
  - Die e2e-Tests schlagen bei jedem CSP- oder Trusted-Types-Verstoß fehl.
  - Ein Lauf durch den echten Caddy-Container blieb ohne Verstoß, mit SSE und Plugin-Chunks.
- **CI:**
  - Job `image` (Matrix server/web): Build mit Buildx, danach Trivy (`HIGH`/`CRITICAL`, nur behebbare).
  - Job `publish`: nur bei Push auf `v2`, nach allen anderen Jobs. Er pusht `staging` und
    `sha-<commit>` nach GHCR und signiert den Digest mit cosign, ohne Schlüssel.
  - `packages: write` und `id-token: write` gelten nur in diesem Job.
- **Akzeptierte Trivy-Befunde:** Sie stehen in `.trivyignore.yaml`, nach derselben Regel wie bei osv:
  eine ID, eine Begründung, ein Ablaufdatum. Erster Eintrag (Owner-Entscheidung 19.11.2026):
  `CVE-2026-78661` in `golang.org/x/net/html` im Caddy-Binary, gültig bis 19.12.2026.
  - Caddy 2.11.9 ist die aktuelle Version und enthält den Fix noch nicht.
  - Unsere Konfiguration verarbeitet kein HTML.
- **Deploy-Skript:** `infrastructure-v2/deploy.sh` mit systemd-Service und -Timer sowie `install.sh`.
  Zusätzlich zur Entscheidung oben:
  - Sperre gegen parallele Läufe
  - Erzeugung des Master-Schlüssels beim ersten Lauf
  - Sicherung vor dem Deploy per `VACUUM INTO` im laufenden Container
  - Ein fehlgeschlagener Digest wird nicht erneut versucht.

  Lokal gegen eine Registry durchgespielt: Erstinstallation, Lauf ohne Änderung, Update, Rollback
  bei einem Image, das nicht startet, und Erholung mit einem neuen Image. cosign war dabei durch eine
  Attrappe ersetzt. Die echte Signaturprüfung zeigt erst der erste Lauf auf Staging.
- **Tägliche Sicherung** im Server: `daily-JJJJ-MM-TT.db` per `VACUUM INTO`, 14 Tage, stündlich
  geprüft.

## Nachtrag: Hosts und Hostname (19.11.2026)

Owner-Entscheidung 19.11.2026:

- **v2:** CT 113, 192.168.2.216.
- **v1:** CT 101, 192.168.2.202. Die Angabe „CT 110“ im Altcode-Teil von `CLAUDE.md` ist veraltet.
- **cloudflared:** CT 110, 192.168.2.213. Das ist `RXF_CLOUDFLARED_IP`.
- **Hostname:** v2 übernimmt direkt `admin.rxf-sys.de`; eine eigene Staging-Domain `admin-next` gibt es
  nicht. Der Umstieg geschieht durch Umstellen des Public Hostname im Tunnel (`docs/OPERATIONS.md`,
  Schritt 5). Der Weg zurück auf v1 ist dieselbe Einstellung in umgekehrter Richtung.
- **Folge für Passkeys (ADR 0005):** Die RP-ID ist von Anfang an `admin.rxf-sys.de`. Die geplante
  Neuregistrierung nach einem Domainwechsel entfällt.
