# admin.rxf-sys.de

Live admin dashboard for the **rxf-sys** homeserver infrastructure.
Surfaces every piece of infra worth keeping an eye on, behind its own
login at `https://admin.rxf-sys.de`:

- **Server** — Proxmox VE host CPU / RAM / disk with rings + per-guest RAM
  breakdown + SMART per disk; LXC and VM inventory with live CPU / RAM
  bars.
- **Übersicht** — system health score, 4 KPI tiles (containers up,
  services healthy, ø response time, 30-day SLA), recent audit activity,
  and the service grid with 30-day uptime per probe.
- **Netzwerk** — UniFi WAN throughput, clients by VLAN, per-device CPU /
  RAM, gateway info.
- **Backup** — PBS datastore donut, per-guest snapshot size, prune-job
  schedule + retention, 30-day jobs-per-day + GB-per-day trend, jobs
  table.
- **Cloudflare** — Tunnel health, **GraphQL-backed Requests card**
  (req/min, cache-hit, edge bandwidth), SSL cert progress bars, full DNS
  record listing for the zone.
- **Audit** — runs the bundled audit script (12 checks), groups findings
  by category with a remediation snippet per finding, score band (A–E
  + 0–100). Toggle for daily auto-audit.
- **Konten** — admin-only user CRUD (4 roles: admin / operator / viewer /
  user-legacy), active session list with prefix-based revoke, API token
  manager (Bearer-token CRUD with enforced read / write / admin scopes,
  one-time reveal), roles overview.
- **Einstellungen** — single-page card grid: account, appearance,
  polling, notifications (toast + browser + **ntfy push**), integrations
  status, security (**2FA via TOTP**, login rate-limit), **E-Mail
  reports via SMTP** with manual trigger, instance name / timezone, and
  a danger zone for cache clear + logout.

## Architecture

```
                        Internet
                           │
                  ┌────────┴────────┐
                  │  Cloudflare     │  TLS termination at the edge
                  │  Edge           │
                  └────────┬────────┘
                           │ outbound tunnel
        ┌──────────────────▼──────────────────┐
        │  cloudflared (Proxmox host or LXC)  │
        └──────────────────┬──────────────────┘
                           │ http://192.168.2.210:80
                  ┌────────▼────────┐
                  │  CT 110  admin  │
                  │   ┌──────────┐  │   docker compose
                  │   │  Caddy   │──┼─► serves SPA (dist/)
                  │   │  :80     │──┼─► /api/* → backend:8080
                  │   └────┬─────┘  │
                  │        │        │
                  │   ┌────▼─────┐  │
                  │   │ FastAPI  │  │   session-cookie + bearer auth,
                  │   │ :8080    │  │   aggregates + caches upstreams,
                  │   └────┬─────┘  │   5 background loops (probes,
                  │        │        │   metrics sampler, cleanup,
                  │   ┌────▼─────┐  │   auto-audit, weekly-report)
                  │   │ SQLite   │  │   accounts + sessions + tokens +
                  │   │ /data/   │  │   app_settings + 2FA + history
                  │   └──────────┘  │
                  └────────┼────────┘
                           │
        ┌──────────────────┴──────────────────────────────┐
        ▼              ▼              ▼              ▼
   Proxmox API     PBS API     Cloudflare API   UniFi local API
   192.168.2.200  192.168.2.209  api.cloudflare.com  192.168.2.1
```

- **Backend** — FastAPI (Python 3.14) + httpx, async, with a TTL cache and
  single-flight de-duplication. All API secrets live server-side; the
  SPA only ever sees the aggregated JSON.
- **Frontend** — Vite 8 + React 19 + TypeScript SPA, dev-mode hot-reload
  with `/api/*` proxied to the backend.
- **Auth** — own login page + local accounts (Argon2id-hashed passwords,
  server-side session cookies in SQLite, rotated on every login).
  Optional second factor via **TOTP** with one-time backup codes and
  replay protection (an accepted code is dead for its whole validity
  window). **API bearer tokens** parallel to cookies for scripts / CI /
  monitoring bots — token scopes are enforced: `read` is GET-only,
  `write` unlocks operator-level mutations, `admin` is required for the
  account-management surface, and a token can never mint one more
  powerful than itself. Four roles (admin / operator / viewer / user);
  admins manage accounts + sessions + tokens in the Konten tab.
  Brute-force throttling on `/api/auth/login` (5 fails / 5 min per IP).
- **Background loops** — service probes every 30 s (cache-decoupled
  from HTTP), metrics sampler every 60 s (host + guests + WAN
  throughput), history cleanup every hour, optional auto-audit
  (daily) and weekly-report (Monday SMTP) loops.
- **Notifications** — Discord/Slack-compatible webhook + **ntfy** push
  + **SMTP weekly report**. Each channel is independent; either can be
  on while the others are off.

## Repository layout

```
backend/                 FastAPI service
  app/
    main.py              app + background loops + router wiring
    auth.py              session-cookie + bearer-token auth dependency
    accounts.py          users, sessions, api_tokens, app_settings
    totp.py              2FA setup, verify, login-code, backup codes
    cache.py             single-flight TTL cache
    config.py            pydantic-settings env model
    models.py            pydantic schemas (used by FE via OpenAPI)
    state.py             in-memory service-probe snapshot
    weekly_report.py     SMTP report builder + sender
    notify.py            webhook + ntfy notification center
    auditor.py           audit-script runner (subprocess + JSON parse)
    storage.py           probe/host/guest/network metrics history
    registry.py          admin-editable service registry
    clients/             proxmox, pbs, cloudflare, unifi, probes
    routers/             /api/{system,services,tunnel,backups,network,
                         certs,audit,admin,account,auth,instance,
                         notifications,cloudflare}
  scripts/audit.sh       12-check audit script (container + host modes)
  tools/                 manage scripts (promote_admin, probe_unifi)
  Dockerfile             includes ss / dig / openssl for the audit script

frontend/                Vite + React 19 + TS SPA
  src/
    App.tsx              section routing + global state
    api/client.ts        typed fetch wrapper for /api/*
    components/          one file per panel; HostPanel + HostGrid,
                         ServiceGrid, VMTable, NetworkPanel,
                         BackupsSection, CloudflareSection, AuditPanel,
                         AdminPanel, SettingsPage, LoginPage, Drawer,
                         primitives (icons, donut, sparkline, TrendBars)
    hooks/               usePoll, useAuth, useTheme, useSection
    styles/              tokens.css + layout.css + layout-extra.css
    types.ts             mirrors the backend pydantic models
  Dockerfile, Caddyfile

infrastructure/          Deployment helpers
  docker-compose.yml
  setup-lxc.sh           one-shot Proxmox host bootstrap
  deploy.sh              CD entry-point (git pull + compose up + health
                         gate — fails the run if the API never turns
                         healthy)
  .env.example           every env var with inline docs

docs/
  SETUP.md               step-by-step deployment + token creation
```

## Quick start

If this is a fresh install, see **[docs/SETUP.md](docs/SETUP.md)** for the
full step-by-step (LXC creation, every API token, env vars, post-install
tasks like 2FA + ntfy + Auto-Audit). The two-line version:

```sh
# On the Proxmox host: one-shot bootstrap
bash <(curl -fsSL https://raw.githubusercontent.com/rxf-sys/admin.rxf-sys.de/main/infrastructure/setup-lxc.sh)

# Inside CT 110
cd /opt/rxf-admin/infrastructure
nano .env                    # paste tokens + BOOTSTRAP_ADMIN_PASSWORD
docker compose up -d --build
```

## Local development

```sh
# Backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cp ../infrastructure/.env.example .env   # set AUTH_ENABLED=false for local
uvicorn app.main:app --reload --port 8080

# Frontend
cd frontend
npm install
npm run dev    # http://localhost:5173, /api/* proxied to :8080
```

With `AUTH_ENABLED=false` the backend stubs every request as a synthetic
admin identity. With auth enabled, set `BOOTSTRAP_ADMIN_PASSWORD` and
`SESSION_COOKIE_SECURE=false` for local http://.

### Tests + lint

```sh
# Backend
cd backend
ruff check app tests
pytest -v --cov=app --cov-fail-under=70

# Frontend
cd frontend
npm run test:cov   # vitest + coverage gate (plain `npm test` for watch mode)
npm run lint
npm run build
```

The CI matrix runs the same commands across Python 3.11 + 3.14 (floor
from `requires-python` and the production image) and Node 20/22.
Backend coverage gate is 70 % (`app/main.py` is omitted — ASGI bootstrap
+ loop wiring, exercised in integration not unit); the frontend gate is
a ratchet (55 % statements / 45 % branches) that fails CI on coverage
regressions.

## Operational notes

- **Service probes** are decoupled from the HTTP request cycle — a
  dedicated 30 s background loop maintains an in-memory snapshot,
  so multiple dashboard tabs never multiply upstream load.
- **TTL cache** (`backend/app/cache.py`) deduplicates concurrent
  requests per key — single-flight for system, tunnel, network and
  backup endpoints.
- **Partial failures don't blank the UI** — every upstream client
  returns `online=false` / empty arrays / a structured `error` field
  on failure rather than 5xx-ing.
- **OpenAPI spec** at `/api/docs` shows every endpoint + schema; useful
  when wiring a Bearer-token script. Only mounted when `APP_ENV` is not
  `production` — the docs are unauthenticated, so the public deployment
  doesn't expose its full route map. Run locally with
  `APP_ENV=development` to browse them.
- **History storage** is SQLite at `/data/rxf-admin.db` (configurable
  via `STORAGE_DB_PATH`). Retention defaults to 7 days, pruned by the
  hourly cleanup loop. Tables: `probe_history`, `service_incidents`,
  `host_metrics`, `guest_metrics`, `network_metrics`, plus the live
  `users` / `sessions` / `api_tokens` / `app_settings` / `user_totp`.
  Mount a Docker volume on `/data` so it survives container restarts.
- **Cloudflare analytics** uses the GraphQL endpoint
  (`httpRequestsAdaptiveGroups`) — the legacy REST
  `/zones/{id}/analytics/dashboard` was retired by Cloudflare for
  Free + Pro zones in 2023. Token needs `Zone : Analytics : Read`.
- **Audit script** has two modes:
  - **Container mode** (default) — runs the 12 checks inside the
    backend container. Container-side checks (DNS, memory, load,
    /data storage, package updates, listening ports) report real
    data; host-only checks (systemctl, smartctl, host iptables)
    surface as SKIP with an explicit hint to set `AUDIT_SSH_HOST`.
  - **SSH mode** — set `AUDIT_SSH_HOST=192.168.2.200`,
    `AUDIT_SSH_USER=root` (+ `AUDIT_SSH_KEY_PATH` if needed). The
    backend pipes the same script via `ssh user@host bash -s` so all
    12 checks run on the Proxmox host. See
    [docs/SETUP.md](docs/SETUP.md#audit-host-side) for the SSH
    bootstrap.
- **2FA recovery** — losing both the authenticator and the eight
  backup codes locks the account. Worst case, exec into the backend
  container and run `sqlite3 /data/rxf-admin.db
  "DELETE FROM user_totp WHERE user_id = (SELECT id FROM users WHERE
  username = '<u>');"` from a console.
- **CPU temperature**: Proxmox VE does not expose host CPU temperature
  through its official API. The dashboard does best-effort sniffing of
  `lm-sensors`-shaped fields, but for stock PVE 8/9 installs it stays
  empty.

## Tech-stack rationale

- **FastAPI + httpx** — async I/O is essential because each dashboard
  refresh fans out to four to five upstream APIs in parallel.
- **Vite + React + TS** — typed wire contract with the OpenAPI-generated
  backend models; Vite keeps the dev loop tight (<200 ms HMR).
- **Caddy** — single binary, automatic compression, trivial reverse
  proxy config. Cloudflare terminates TLS at the edge so plain :80
  inside the LXC is sufficient.
- **pyotp + qrcode** — tiny, stdlib-friendly TOTP and SVG QR rendering
  so the backend can embed the provisioning URI directly in the
  enrollment response (no client-side QR library needed).
- **stdlib smtplib via asyncio.to_thread** — weekly report goes through
  blocking smtplib in a thread instead of pulling in `aiosmtplib`; cuts
  one dependency at the cost of one off-loop thread per send (acceptable
  for a weekly cadence).

## Roadmap

See [CLAUDE.md](CLAUDE.md#roadmap-ausstehend) for the still-open items
(i18n via react-i18next, first-login onboarding wizard with per-user
tab config).

## License

MIT — see [LICENSE](LICENSE) if present, otherwise: do what you want, no
warranty.
