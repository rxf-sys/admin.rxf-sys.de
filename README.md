# admin.rxf-sys.de

Live admin dashboard for the **rxf-sys** homeserver infrastructure.
It complements the public landing page at <https://rxf-sys.de> on a
separate, Cloudflare-Access-protected subdomain
(`https://admin.rxf-sys.de`) and surfaces:

- Proxmox VE host CPU / RAM / disk + LXC and VM inventory
- HTTP probes for all 8 service subdomains (intern + extern)
- Cloudflare Tunnel health, connections and WAN IP
- Proxmox Backup Server jobs, verification status and datastore usage
- UniFi Cloud Gateway WAN throughput and connected clients
- Cloudflare Edge certificate expiry + DNS-record consistency check

## Architecture

```
                        Internet
                           │
                  ┌────────┴────────┐
                  │  Cloudflare     │  TLS termination + Access (Email-OTP)
                  │  Edge / Access  │
                  └────────┬────────┘
                           │ outbound tunnel
        ┌──────────────────▼──────────────────┐
        │  CT 104  cloudflared (192.168.2.205)│
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
                  │   │ FastAPI  │  │   verifies Cf-Access-Jwt-Assertion,
                  │   │ :8080    │  │   aggregates + caches all upstream APIs
                  │   └────┬─────┘  │
                  └────────┼────────┘
                           │
        ┌──────────────────┴──────────────────────────────┐
        ▼              ▼              ▼              ▼
   Proxmox API     PBS API     Cloudflare API   UniFi local API
   192.168.2.200  192.168.2.209   api.cloudflare.com   192.168.2.1
```

- **Backend** — FastAPI (Python 3.12) + httpx, async, with a TTL cache and
  single-flight de-duplication. All API secrets live server-side; the SPA
  only ever sees the aggregated JSON.
- **Frontend** — Vite + React 18 + TypeScript SPA.
- **Auth** — Cloudflare Access enforces login at the edge. The backend
  re-validates `Cf-Access-Jwt-Assertion` against
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` on every
  request and refuses requests without a valid AUD-matching token.
- **Polling** — frontend polls each section every 15 s (system, services,
  tunnel, network) or 60 s (backups), with a manual refresh button.

## Repository layout

```
backend/                FastAPI service
  app/
    main.py             app + routers
    auth.py             Cloudflare Access JWT verification
    cache.py            single-flight TTL cache
    config.py           pydantic-settings env model
    models.py           pydantic schemas (used by FE via OpenAPI)
    clients/            proxmox / pbs / cloudflare / unifi / probes
    routers/            /api/system, /services, /tunnel, /backups, /network, /certs
  Dockerfile

frontend/               Vite + React + TS SPA
  src/
    App.tsx
    main.tsx
    api/client.ts       typed fetch wrapper for /api/*
    components/         Header, OverviewCards, ServiceGrid, VMTable,
                        NetworkPanel, BackupsCerts, Drawer, ConfirmModal,
                        Toasts, primitives (icons, donut, sparkline)
    hooks/              usePoll, useTheme
    styles/             tokens.css + layout.css
    types.ts
  Dockerfile, Caddyfile

infrastructure/         Deployment helpers
  docker-compose.yml
  setup-lxc.sh          one-shot Proxmox host bootstrap
  .env.example
```

## Deployment

### 1. Prepare the LXC

From a Proxmox host shell:

```sh
git clone https://github.com/rxf-sys/admin.rxf-sys.de.git /tmp/admin
cd /tmp/admin/infrastructure
# Optional overrides: CT_ID, IP_CIDR, GATEWAY, RAM_MB, CORES, ROOT_PASSWORD
bash setup-lxc.sh
```

The script creates an unprivileged Debian 12 LXC (default `CT 110`,
`192.168.2.210`), installs Docker + Compose, clones this repo to
`/opt/rxf-admin`, and copies `.env.example` to `.env`.

### 2. Create API tokens

#### Proxmox VE

Datacenter → Permissions → Users → **Add** `admin-dashboard@pve`.
Datacenter → Permissions → API Tokens → **Add** for that user, name `api`,
*Privilege Separation = on*.

Datacenter → Permissions → Permissions → **Add** for path `/`:

- User `admin-dashboard@pve`, role `PVEAuditor` (read-only)
- For the optional Restart button: also add `VM.PowerMgmt` on
  `/vms/<vmid>` for the IDs you want restartable.

Copy `<userid>!<token-name>` and the token secret into
`PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET`.

#### Proxmox Backup Server

Configuration → Access Control → **Add** user `admin-dashboard@pbs`.
**Add** API token for that user.
Datastore → `<your-datastore>` → Permissions → **Add** for the user with
role `DatastoreAudit`.

Copy into `PBS_TOKEN_ID` / `PBS_TOKEN_SECRET`.

#### Cloudflare API

<https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
*Custom* with these permissions:

| Type    | Permission                       | Resources                  |
|---------|----------------------------------|----------------------------|
| Account | Cloudflare Tunnel · *Read*       | Account `rxf-sys`          |
| Zone    | DNS · *Read*                     | Zone `rxf-sys.de`          |
| Zone    | SSL and Certificates · *Read*    | Zone `rxf-sys.de`          |

Copy the token into `CF_API_TOKEN`. Fill in `CF_ZONE_ID` (Zone Overview
sidebar) and `CF_TUNNEL_ID` (Zero Trust → Networks → Tunnels → details).

#### UniFi (local UCG-Ultra)

Settings → Admins → **Create New Admin** → *Restrict to local access only*.
Pick a user with read-only role and put credentials into
`UNIFI_USERNAME` / `UNIFI_PASSWORD`.

> **Cloud SSO accounts cannot be used here** — the LAN API requires a
> proper local user.

### 3. Cloudflare Tunnel + Access

In the Zero Trust dashboard:

1. Networks → Tunnels → `rxf-sys-home` → **Public Hostname** →
   **Add a public hostname**:
   - Subdomain `admin`, domain `rxf-sys.de`
   - Service `HTTP` → `192.168.2.210:80`

2. Access → Applications → **Add an application** → *Self-hosted*:
   - Application domain `admin.rxf-sys.de`
   - Identity providers → *One-time PIN* (Email-OTP)
   - Policy: `Include → Emails → robin@rxf-sys.de` (or your team)

3. Open the application's settings → **General** → copy the
   **Application Audience (AUD) Tag** and put it into
   `CF_ACCESS_AUD` in `.env`.

### 4. Bring it up

```sh
pct enter 110
cd /opt/rxf-admin/infrastructure
nano .env                    # paste tokens
docker compose up -d --build
docker compose logs -f       # watch the first probes
```

Visit <https://admin.rxf-sys.de> → Cloudflare Access prompts for the
email OTP → after authentication the dashboard loads.

## Local development

```sh
# Backend (terminal 1)
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e .
cp ../infrastructure/.env.example .env   # set AUTH_ENABLED=false for local
uvicorn app.main:app --reload --port 8080

# Frontend (terminal 2)
cd frontend
npm install
npm run dev    # http://localhost:5173, /api/* proxied to :8080
```

With `AUTH_ENABLED=false` the backend stubs the identity as `dev@local`
so you can iterate without Cloudflare in the loop.

## Operational notes

- The TTL cache (`backend/app/cache.py`) deduplicates concurrent requests
  per key — the dashboard with 6 sections triggers at most 1 upstream
  call per service per TTL window, regardless of how many tabs are open.
- All upstream clients return *partial* data on failure (`online=false`,
  empty arrays) rather than 5xx — one broken integration cannot blank
  the whole dashboard.
- Browse the OpenAPI spec at <https://admin.rxf-sys.de/api/docs> if the
  dashboard is reporting unexpected values.
- **CPU temperature**: Proxmox VE does not expose host CPU temperature
  through its official API — there is no documented `cputemp` field on
  `/nodes/{node}/status`. The dashboard does best-effort sniffing of the
  various shapes `lm-sensors` output can take if a node operator has
  patched `pveproxy` to surface it, but for stock PVE 8/9 installs the
  field will simply stay empty. If you need temperatures, run a separate
  node-exporter / IPMI exporter and chart it elsewhere.
- **External vs. internal probes**: the public-hostname probes (through
  Cloudflare) verify TLS, so a DNS hijack or expired edge cert shows up
  as `ext=false`. The internal LAN probes (`probe_targets`) keep TLS
  verification off because home-lab services typically use self-signed
  or private-CA certs.

## Tech-stack rationale

- **FastAPI + httpx** — async I/O is essential because each dashboard
  refresh fans out to four to five upstream APIs in parallel.
  Pydantic schemas double as the wire contract consumed by the frontend
  via the generated OpenAPI document.
- **Vite + React + TypeScript** — TS gives us a typed wire contract with
  the OpenAPI-generated backend models, and Vite keeps the dev loop tight.
- **Caddy** — single binary, automatic compression, trivial reverse
  proxy config. Cloudflare terminates TLS at the edge so plain :80
  inside the LXC is sufficient.
