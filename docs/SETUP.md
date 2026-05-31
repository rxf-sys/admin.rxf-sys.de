# Setup

Step-by-step from a fresh Proxmox host to a running dashboard with all
optional features wired up. Allow about 30 min the first time.

## 0 · Prerequisites

- Proxmox VE 8 or 9 host with internet access
- A Cloudflare account that owns your zone (`rxf-sys.de` in this guide)
- Optional: Proxmox Backup Server on the same LAN
- Optional: UniFi controller (UDM Pro / UCG / hosted)
- Optional: ntfy server (self-hosted via `ntfy serve`) for push
- Optional: SMTP credentials (Fastmail / Postmark / Mailgun / Office365 /
  a self-hosted Postfix) for the weekly report

The dashboard's six core sections degrade gracefully — if you skip a
token now, the panel just shows an empty-state. Add credentials later,
restart, and the data appears.

## 1 · Create the LXC

From a Proxmox host shell:

```sh
git clone https://github.com/rxf-sys/admin.rxf-sys.de.git /tmp/admin
cd /tmp/admin/infrastructure
# Optional overrides: CT_ID, IP_CIDR, GATEWAY, RAM_MB, CORES, ROOT_PASSWORD
bash setup-lxc.sh
```

The script creates an unprivileged Debian 12 LXC (default `CT 110`,
`192.168.2.210`, 2 GB RAM, 2 cores), installs Docker + Compose, clones
this repo to `/opt/rxf-admin`, and copies `.env.example` to `.env`.

If you already have an LXC and just want to bring up the stack, skip to
section 5.

## 2 · Generate API tokens

You can do these in any order. The dashboard tolerates missing tokens —
empty values disable that panel rather than 5xx.

### 2.1 Proxmox VE (required)

1. **Datacenter → Permissions → Users → Add**
   - User: `admin-dashboard`
   - Realm: `pve`
2. **Datacenter → Permissions → API Tokens → Add**
   - User: `admin-dashboard@pve`
   - Token ID: `api`
   - Privilege Separation: **ON** (recommended)
   - Copy the token secret — Proxmox only shows it once
3. **Datacenter → Permissions → Permissions → Add**
   - Path: `/`
   - User: `admin-dashboard@pve`
   - Role: `PVEAuditor` (read-only)
4. *Optional, for the Restart button*: add `VM.PowerMgmt` on
   `/vms/<vmid>` for the IDs you want restartable.

Paste into `.env`:

```dotenv
PROXMOX_TOKEN_ID=admin-dashboard@pve!api
PROXMOX_TOKEN_SECRET=<the-secret>
```

### 2.2 Proxmox Backup Server (optional)

If you have PBS:

1. **Configuration → Access Control → Add** user
   `admin-dashboard@pbs`.
2. **Add API token** for that user, name `api`.
3. **Datastore → `<your-store>` → Permissions → Add**
   - User: `admin-dashboard@pbs`
   - Role: `DatastoreAudit` (read-only).
4. *Optional, for the inline Verify button*: use a custom role that
   includes `Datastore.Verify` instead of (or in addition to) Audit.
   Read-only `DatastoreAudit` will return 403 on
   `POST /admin/datastore/<store>/verify` and the dashboard surfaces
   that as a toast.

Paste into `.env`:

```dotenv
PBS_TOKEN_ID=admin-dashboard@pbs!api
PBS_TOKEN_SECRET=<the-secret>
PBS_DATASTORE=<your-datastore-name>
```

### 2.3 Cloudflare (required for the Cloudflare tab)

<https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
*Custom token* with these permissions:

| Type    | Permission                       | Resources                  |
|---------|----------------------------------|----------------------------|
| Account | Cloudflare Tunnel · Read         | Account that owns the zone |
| Zone    | DNS · Read                       | Zone `rxf-sys.de`          |
| Zone    | SSL and Certificates · Read      | Zone `rxf-sys.de`          |
| Zone    | **Analytics · Read**             | Zone `rxf-sys.de`          |

> **Analytics scope is mandatory** for the Requests card on the
> Cloudflare tab — the GraphQL backend rejects the query with 403
> otherwise.

Paste into `.env`:

```dotenv
CF_API_TOKEN=<the-token>
CF_ZONE_ID=<from-zone-overview-sidebar>
CF_TUNNEL_ID=<from-zero-trust-tunnels-detail>
CF_ZONE_NAME=rxf-sys.de
```

### 2.4 UniFi (optional, for the Network tab)

Two auth modes — pick one:

#### 2.4a Integration API (preferred, UniFi OS 4.x+)

1. **Network → Settings → Control Plane → Integrations → Add API Key**
   - Name: `rxf-admin`
   - Copy the key

```dotenv
UNIFI_HOST=192.168.2.1
UNIFI_API_KEY=<the-key>
UNIFI_USERNAME=
UNIFI_PASSWORD=
```

> **Trade-off** — the Integration API does **not** return live WAN
> throughput or per-device CPU/RAM (UniFi's design choice). The
> dashboard surfaces "—" for those fields. If you need live
> throughput, use the cookie-auth fallback below.

#### 2.4b Local-admin cookie auth (legacy, full data)

1. **Network → Settings → Admins → Create New Admin**
   - Restrict to **Local Access** (cloud SSO accounts do **not** work)
   - Read-only role

```dotenv
UNIFI_HOST=192.168.2.1
UNIFI_API_KEY=
UNIFI_USERNAME=rxf-admin
UNIFI_PASSWORD=<the-password>
```

## 3 · Cloudflare Tunnel routing

In the Zero Trust dashboard:

1. **Networks → Tunnels → `rxf-sys-home` → Public Hostname → Add a
   public hostname**
   - Subdomain: `admin`
   - Domain: `rxf-sys.de`
   - Service: `HTTP` → `192.168.2.210:80`

The dashboard authenticates users itself (login + sessions + 2FA), so a
Cloudflare Access application is **not** required.

## 4 · Bootstrap the first admin

```dotenv
BOOTSTRAP_ADMIN_USER=admin
BOOTSTRAP_ADMIN_PASSWORD=<a-strong-password>
```

The backend creates this account on first start when the users table is
empty. Once you log in, change the password and create the real accounts
in the **Konten** tab. Leaving `BOOTSTRAP_ADMIN_PASSWORD` empty disables
the auto-bootstrap — useful if you already have admins in the DB.

If you lose access to every admin account, exec into the container and:

```sh
docker compose exec backend python -m tools.promote_admin <username>
```

The script is idempotent and reactivates a disabled account.

## 5 · Bring it up

```sh
pct enter 110
cd /opt/rxf-admin/infrastructure
nano .env                    # paste everything you collected above
docker compose up -d --build
docker compose logs -f       # watch the first probes
```

Visit `https://admin.rxf-sys.de` → log in with the bootstrap admin.

## 6 · Post-install (all optional)

The first five steps cover the **read-only dashboard**. The next blocks
are for features you turn on in the Einstellungen tab after first login —
each section persists into the `app_settings` table inside SQLite, so a
restart preserves the choice.

### 6.1 Two-factor auth (TOTP)

For every admin / operator account:

1. Log in → **Einstellungen** → Sicherheit & Audit → 2FA → **Aktivieren**
2. Scan the QR with Aegis / 1Password / Google Authenticator
3. Confirm the 6-digit code
4. **Copy the 8 backup codes** — they're shown once and never again

The login page handles the second step automatically — username +
password gets you a `totp_required: true` response, the form swaps to a
code input. Backup codes are accepted in the same field and consumed
single-use.

### 6.2 ntfy push notifications

Self-host ntfy on the same LAN (or use ntfy.sh with an unguessable
topic). In the Einstellungen tab → Benachrichtigungen:

- **ntfy-Server**: `https://ntfy.example.com` (no trailing slash)
- **ntfy-Topic**: `rxf-admin` (anything — unique strings act as the auth
  on public ntfy.sh)
- **ntfy-Token**: only required for protected topics
- **Test-Push** sends one message immediately so you can verify

The notification center fires on service degradation, backup failures,
expiring certs, and tunnel state changes — same triggers as the
Discord/Slack webhook.

### 6.3 Weekly SMTP report

Einstellungen → E-Mail-Reports (SMTP):

- **SMTP-Server**: host + port (commonly 587 for STARTTLS, 465 for SSL)
- **SMTP-User / SMTP-Passwort**: login (or app password)
- **STARTTLS**: on for port 587, off for 465
- **From-Adresse**: optional — falls back to SMTP-User
- **Empfänger**: comma-separated list
- **Wochenreport: ON** + UTC hour
- **Test-Report** sends one message right now — useful for proving the
  SMTP creds before waiting until Monday

The report aggregates per-service uptime (7-day window), audit-run
count + last summary, and today's PBS job counters. Sent every Monday at
the configured UTC hour.

### 6.4 Auto-Audit

Einstellungen → Sicherheit & Audit → Auto-Audit: **ON** + hour. The
background loop ticks every 5 min, fires `auditor.start_run` exactly
once per UTC day at the chosen hour. Uses the same script + same
job-history table as a manual run from the Audit tab.

### 6.5 Audit host-side (SSH)

The bundled audit script runs the 12 checks. By default it runs *inside
the backend container*, where it can read DNS / memory / load /
container ports / `/data` storage, but **cannot** see the host's
systemctl, smartctl, iptables, or sshd_config. Those checks SKIP with a
helpful hint.

For full coverage:

1. Inside the LXC: generate an SSH key for root in the backend
   container's persisted volume:

   ```sh
   docker compose exec backend bash -c 'ssh-keygen -t ed25519 -f /data/id_audit -N ""'
   docker compose exec backend cat /data/id_audit.pub
   ```

2. On the Proxmox host (`pct enter 110` → then ssh out, or paste
   directly):

   ```sh
   echo '<the-pub-key>' >> /root/.ssh/authorized_keys
   chmod 600 /root/.ssh/authorized_keys
   ```

3. In `.env`:

   ```dotenv
   AUDIT_SSH_HOST=192.168.2.200
   AUDIT_SSH_USER=root
   AUDIT_SSH_KEY_PATH=/data/id_audit
   ```

4. `docker compose up -d` to pick up the env change.

Now the audit script gets piped via `ssh root@192.168.2.200 bash -s`
and runs on the host — all 12 checks return real data.

### 6.6 API bearer tokens

For monitoring bots, CI, or `curl` from a script:

1. **Konten → Token erstellen**: name, scope (read / write / admin),
   optional TTL.
2. **Copy the token immediately** — it's shown once.
3. Use it with `Authorization: Bearer rxf_<43chars>`:

   ```sh
   curl -H "Authorization: Bearer rxf_..." \
        https://admin.rxf-sys.de/api/services
   ```

Tokens are independent of cookie sessions. An admin can revoke any
token from the Konten tab; a user can revoke their own from
`/api/account/tokens`. `last_used_at` updates on every successful auth so
unused tokens are easy to spot.

### 6.7 Instance branding

Einstellungen → Allgemein:

- **Instanz-Name** — shown in the header logo + browser tab title
- **Zeitzone** — IANA name; currently informational (display formatting
  follows it in a future patch)
- **Zeitformat** — 24h / 12h

Persisted into `app_settings`, so changes survive a redeploy.

## 7 · Auto-deploy on push

CD via `.github/workflows/cd.yml`. Required GitHub Secrets:

| Secret           | Description                                       |
|------------------|---------------------------------------------------|
| `DEPLOY_HOST`    | LXC IP (`192.168.2.210`) or SSH alias             |
| `DEPLOY_USER`    | SSH user (typically `root`)                       |
| `DEPLOY_SSH_KEY` | Private key (ED25519 recommended)                 |

A push to `main` triggers CI → on green, CD SSHes into the LXC, pulls
`/opt/rxf-admin`, runs `docker compose up -d --build`. No restart of the
LXC itself.

## 8 · Backup the SQLite

The dashboard's own state (accounts, sessions, API tokens, app
settings, 2FA secrets, audit job history, probe history) lives in the
single SQLite file `/data/rxf-admin.db` inside the named Docker volume
`rxf-admin-data`. Daily cron from the LXC:

```sh
# /etc/cron.daily/backup-rxf-admin
#!/bin/sh
set -e
docker exec rxf-admin-backend sqlite3 /data/rxf-admin.db \
  ".backup /data/rxf-admin.db.bak"
mkdir -p /opt/backups/rxf-admin
cp /var/lib/docker/volumes/rxf-admin-data/_data/rxf-admin.db.bak \
   /opt/backups/rxf-admin/rxf-admin-$(date +%Y%m%d).db
find /opt/backups/rxf-admin -name 'rxf-admin-*.db' -mtime +30 -delete
```

`sqlite3 .backup` is online — no need to stop the backend. The PBS
prune job in the dashboard's Backup tab is for the **PBS** datastore,
not this SQLite file.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login page loads but `/api/auth/me` returns 401 | Cookie was set by HTTP but the browser is on HTTPS. Set `SESSION_COOKIE_SECURE=true` (production) or `false` (local http). |
| Cloudflare Requests card says `Token-Scope unzureichend` | Add `Zone : Analytics : Read` to `CF_API_TOKEN`. |
| Audit tab is empty after clicking Neu prüfen | Check `docker compose logs backend` for `auditor.execute_failed`. Most common cause: `scripts/audit.sh` is not executable inside the container (the Dockerfile chmods it, so a stale image is the usual culprit — rebuild). |
| 2FA QR doesn't render | Older browsers without inline-SVG support — paste the `secret_b32` value into the authenticator manually. |
| ntfy `Test-Push` fails with 401 | Protected topic — set the bearer token. |
| Weekly report `Test-Report` fails with `[SSL: ...]` | `STARTTLS=true` on port 465 or `STARTTLS=false` on 587 — flip the toggle. |
| Auto-Audit doesn't fire at the configured hour | UTC vs local time confusion — the hour in the picker is **UTC**, not your local timezone. |
| Service drawer says "history disabled" | `STORAGE_DB_PATH=""` in `.env` (history off) or the `/data` volume is read-only. |
