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
