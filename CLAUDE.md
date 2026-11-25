# admin.rxf-sys.de

Admin-Dashboard für den Homeserver (rxf-sys.de). Überwacht Services, zeigt Probe-Historien.
Zugang über eigene Account-Auth (Argon2id + Session-Cookies); Bootstrap-Admin beim ersten Start.

## Architektur

```
├── backend/                 # FastAPI (Python 3.11+) — REST API + SQLite
│   ├── app/                 # Anwendungscode
│   ├── tests/               # pytest Tests
│   ├── tools/               # Hilfsskripte
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/                # Vite + React + TypeScript
│   ├── src/
│   ├── Dockerfile           # Multi-stage: build → Caddy
│   ├── Caddyfile
│   └── package.json
└── infrastructure/
    ├── docker-compose.yml   # Backend + Frontend als Docker-Services
    ├── .env.example         # Alle benötigten Umgebungsvariablen
    ├── deploy.sh            # Deploy-Script (CD-Pipeline + manuell)
    └── setup-lxc.sh        # Proxmox LXC Bootstrap (einmalig)
```

## v2-Neubau (Branch `v2`)

Der Neubau entsteht neben dem Altcode als pnpm-Monorepo (ADR 0002). `main`
und der Altcode bleiben unberührt, bis der Umstieg abgenommen ist (Phase 9).
Teil-PRs gehen nach `v2`, nie nach `main`.

```text
apps/server        @rxf/server   Fastify-Kern, API unter /api
apps/web           @rxf/web      React-Shell (Vite)
packages/contracts @rxf/contracts API-Schemas (zod/mini), von Server und Web geteilt
packages/i18n      @rxf/i18n     typisierte Kataloge, Deutsch ist Quellsprache
packages/ui        @rxf/ui       Design-Tokens und Schriften (docs/design/README.md)
e2e                @rxf/e2e      Playwright + axe, Screenshots 1440/390 hell/dunkel
packages/web-sdk   @rxf/web-sdk  Web-Vertrag der Plugins (Widgets, Onboarding)
infrastructure-v2/               Compose, Caddyfile, Pull-Deploy (docs/OPERATIONS.md)
```

```bash
pnpm install                 # Node 26 + pnpm 12 (packageManager); Cloud-Sessions: SessionStart-Hook
RXF_DATA_DIR=.data RXF_MASTER_KEY=$(pnpm -s --filter @rxf/server keygen) pnpm dev:server   # Node führt TS direkt aus
pnpm dev:web                 # Vite, /api → 127.0.0.1:3000
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm size && pnpm knip
pnpm e2e                     # lokal: PW_CHROMIUM_PATH auf vorhandenes Chromium setzen
```

Konventionen:

- **Fertig heißt:** alle Gates aus `.github/workflows/ci-v2.yml` grün (ADR 0009).
- **Coverage:** Kern ≥ 80 %, je Plugin ≥ 70 %.
- **Workspace-Pakete** exportieren ihre TS-Quellen unter der Bedingung
  `@rxf/source` (Vite, Vitest, Node im Dev-Modus) und `dist/` für
  Produktion. Node strippt keine Typen in `node_modules`, Docker-Deploys
  kopieren Pakete aber genau dorthin.
- **Zod im Web** immer als Namespace importieren:
  `import * as z from 'zod/mini'` (Biome-Regel).
- **API-Antworten** prüft das Web gegen das Schema aus `@rxf/contracts`.
- **TypeScript** mit `erasableSyntaxOnly`: keine Enums, Namespaces oder
  Parameter-Properties.
- **Neue Abhängigkeiten** nur nach Freigabe (`docs/architecture/dependencies.md`).
- **Install-Skripte** nur per Allowlist (`allowBuilds` in
  `pnpm-workspace.yaml`).

## Lokale Entwicklung

```bash
# Backend
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload

# Frontend
cd frontend && npm ci && npm run dev
```

## Deployment Altcode (Proxmox LXC CT 101, 192.168.2.202)

v2 läuft auf CT 113 (192.168.2.216) unter `admin.rxf-sys.de`, cloudflared auf CT 110 (192.168.2.213);
Betrieb siehe `docs/OPERATIONS.md`.

```bash
# Einmalig: LXC aufsetzen (vom Proxmox Host)
bash infrastructure/setup-lxc.sh

# Manueller Deploy (im LXC)
bash /opt/rxf-admin/infrastructure/deploy.sh
```

Automatisierter CD via `.github/workflows/cd.yml` — GitHub Secrets benötigt:
| Secret | Beschreibung |
|---|---|
| `DEPLOY_HOST` | IP des LXC (`192.168.2.202`) oder Cloudflare Tunnel SSH-Hostname |
| `DEPLOY_USER` | SSH-Nutzer (z.B. `root`) |
| `DEPLOY_SSH_KEY` | Privater SSH-Schlüssel (ED25519 empfohlen) |

## Wichtige Konventionen

- **Backend**: FastAPI, strukturiertes Logging via `structlog`, Argon2 für Passwörter
- **Auth**: Eigene Sessions — Cookie `rxf_session` (httpOnly + Secure + SameSite=Lax), Passwörter mit Argon2id, RBAC `admin`/`user` via `accounts.role`, Brute-Force-Throttle pro IP (5 Fehlversuche / 5 min). Bootstrap des ersten Admins über `BOOTSTRAP_ADMIN_USER` / `BOOTSTRAP_ADMIN_PASSWORD`.
- **Daten**: SQLite unter `/data/` (Docker Volume `rxf-admin-data`) — kein externer DB-Server
- **Secrets**: Niemals `.env` committen — nur `.env.example` ist versioniert
- **Tests**: `pytest -v --cov=app --cov-fail-under=70` — 70% Coverage als Mindestgrenze
- **Kein direkter Port nach außen**: Cloudflare Tunnel → Port 80 (Docker `web`-Container)

## Rollen / sichtbare Tabs

Die Tabs `Audit` und `Konten` (`AdminPanel`) sind `adminOnly` — sie erscheinen nur,
wenn `/api/auth/me` `role: "admin"` zurückgibt. Wenn ein Tab im Live-Build fehlt
obwohl der Code ihn enthält, liegt es fast immer an der Rolle des angemeldeten
Accounts. Beförderung eines Bestandsnutzers gegen die laufende DB:

```bash
# im Container
docker compose exec backend python -m tools.promote_admin <username>

# oder auf dem LXC-Host
cd /opt/rxf-admin/backend && python -m tools.promote_admin <username>
```

Das Script ist idempotent (zweimal aufgerufen meldet "already an active admin")
und reaktiviert nebenbei einen ggf. deaktivierten Account.

## Roadmap

Die frühere v1-Roadmap (i18n, Onboarding-Wizard) ist im v2-Neubau aufgegangen:
v2 hat ein typisiertes i18n-Paket (`packages/i18n`) und einen Onboarding-Wizard.
Offene v2-Phasen: 5 Integrationen (PVE, PBS, Cloudflare, UniFi, danach neue),
6 Board-Import/-Export, 7 Alarme, 8 ASVS-Nachweis und Lasttest, 9 Umstieg.

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Lint + Tests + Coverage + Build bei Push/PR auf `main`
- **CD** (`.github/workflows/cd.yml`): Auto-Deploy per SSH nach erfolgreichem CI auf `main`

## SQLite Backup

Das Volume `rxf-admin-data` enthält die Probe-Historien-Datenbank.
Empfehlung: täglicher Cronjob im LXC:
```bash
# /etc/cron.daily/backup-rxf-admin
docker exec rxf-admin-backend sqlite3 /data/probes.db ".backup /data/probes.db.bak"
cp /data/probes.db.bak /opt/backups/rxf-admin/probes-$(date +%Y%m%d).db
```
