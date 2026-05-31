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

## Lokale Entwicklung

```bash
# Backend
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload

# Frontend
cd frontend && npm ci && npm run dev
```

## Deployment (Proxmox LXC CT 110, 192.168.2.210)

```bash
# Einmalig: LXC aufsetzen (vom Proxmox Host)
bash infrastructure/setup-lxc.sh

# Manueller Deploy (im LXC)
bash /opt/rxf-admin/infrastructure/deploy.sh
```

Automatisierter CD via `.github/workflows/cd.yml` — GitHub Secrets benötigt:
| Secret | Beschreibung |
|---|---|
| `DEPLOY_HOST` | IP des LXC (`192.168.2.210`) oder Cloudflare Tunnel SSH-Hostname |
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

## Roadmap (ausstehend)

Wird angegangen, wenn alles andere stabil läuft:

- **i18n (DE/EN-Switch via `react-i18next`)** — ~6 h, boilerplate-intensiv
  weil alle UI-Strings extrahiert werden müssen. Setup für die Toolchain
  + Translation-Dateien + Sprach-Selector im SettingsPage.
- **Onboarding-Wizard** — ~15 h, der dicke Brocken am Ende. First-Login
  zeigt eine Schritt-für-Schritt-Maske: API-Keys eingeben (PVE, PBS,
  Cloudflare, UniFi, optional ntfy/SMTP), Test-Probe pro Integration,
  Tab-Auswahl (welche Tabs der User aktivieren möchte). Pro-User-Config
  persistieren + dynamisches Tab-Rendering basierend darauf.

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
