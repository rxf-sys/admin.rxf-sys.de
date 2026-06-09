# Backend-Audit — admin.rxf-sys.de

Stand: 2026-06-09 · Branch `claude/affectionate-gauss-bVelI`
Umfang: `backend/app` (~7.600 LOC, 14 Router, 7 Clients, Core-Module)

> **Status: alle P1/P2-Funde umgesetzt** (Commit folgt).
> - 196/196 Tests grün (+32 neue), Coverage **77,8 %** (vorher 70 %)
> - Session-Tokens werden jetzt gehasht in SQLite gespeichert (Schema-Migration inklusive)
> - Restart-/Verify-Endpoints sind hinter Operator+-Gate
> - Rate-Limiter ist proxy-aware (CF-Connecting-IP / X-Forwarded-For)
> - 6 vorher ungetestete Router haben jetzt End-to-End-Tests

## Status quo (gut)

- **SQL ist sauber parametrisiert** überall (kein f-string-Injection)
- **Background-Tasks werden im Lifespan korrekt gecanceled**
- **Argon2 mit Timing-Equalisierung** auf dem Login-Pfad (`_DUMMY_HASH`)
- **API-Tokens werden gehasht** (`sha256`) — Session-Tokens jetzt auch
- **Pydantic-Modelle nutzen Constraints durchgängig** (`max_length`, `pattern`, `ge`/`le`)
- **Audit-Logging** ohne PII/Secrets

---

## P1 — Echte Sicherheits-/Korrektheits-Bugs (alle gefixt)

### 1. ✅ Session-Tokens wurden plaintext in SQLite gespeichert
**Datei:** `app/accounts.py:52-58` (Schema), `:399-453` (Lifecycle)

API-Tokens waren immer gehasht (`token_hash` Spalte), Session-Tokens dagegen lagen
roh in der `sessions.token`-Primärschlüssel-Spalte. Ein Leak der SQLite-Datei
(Backup, Container-Snapshot) erlaubte sofortige Wiederverwendung jeder aktiven
Cookie-Session.

**Fix:** Schema-Migration auf `token_hash` (sha256) + `token_prefix` (für die
Admin-Sessions-Liste und Revoke-by-Prefix). Vorhandene Legacy-Zeilen werden
beim ersten Boot per `_migrate_sessions_predrop` dropped (Plaintext kann
nachträglich nicht gehasht werden — Re-Login ist günstiger als Plaintext
lebenslang zu behalten).

### 2. ✅ Restart-Endpoint war für jeden Logged-in-Nutzer offen
**Datei:** `app/routers/system.py:87-110`

`POST /api/system/guests/{vmid}/restart` hing nur an `verify_session` — ein
viewer-rolliger Account konnte VMs/CTs neu starten. **Fix:**
`Depends(require_role("admin", "operator"))`.

### 3. ✅ PBS-Verify-Endpoint war für jeden Logged-in-Nutzer offen
**Datei:** `app/routers/backups.py:32-44`

Gleiche Klasse Bug: Verify-Jobs kosten PBS-Ressourcen, ein Viewer hätte sie
spammen können. **Fix:** `require_role("admin", "operator")`.

### 4. ✅ Rate-Limiter brach hinter Reverse-Proxy
**Datei:** `app/routers/auth.py:31-50`, `app/config.py`

`request.client.host` ist hinter einem Cloudflare-Tunnel / Caddy immer die
Proxy-IP → ein globaler 5-Fehlversuch-Bucket. Eine Person kann alle anderen
aussperren.

**Fix:** Neues `trust_proxy_headers`-Setting (default off → sicher).
Wenn aktiviert, wird `_client_ip()` aus `CF-Connecting-IP` →
`X-Forwarded-For[0]` → `X-Real-IP` → Socket abgeleitet.

### 5. ✅ Audit-Conflict-Response war nicht JSON-string-kompatibel
**Datei:** `app/routers/auditor.py:32-39`

`HTTPException(detail={"message": ..., "job_id": ...})` produzierte
`{"detail": {...}}` als Response; das Frontend rendert das als
`[object Object]` in Toasts. **Fix:** `detail` ist jetzt ein String,
in-flight Job-ID per `X-Running-Job-Id`-Header.

---

## P2 — Hardening

### 6. ✅ UPID nicht url-encodiert beim PVE-Call
**Datei:** `app/clients/proxmox.py:291,393`

`f"/nodes/{node}/tasks/{upid}/log"` — wenn ein Caller (oder
ein Bug an einer Stelle) eine UPID mit `..` oder `/` reinreicht, könnte
das aus der `tasks/`-Subtree auf PVE rauslaufen. **Fix:**
`quote(upid, safe="")` in beiden Stellen.

---

## P3 — Test-Coverage-Lücken

### 7. ✅ 7 Router hatten 0 % Coverage
**Vorher:** `backups`, `certs`, `cloudflare`, `instance`, `network`,
`notifications`, `tunnel`.

**Jetzt** (neue Datei `tests/test_routers_misc.py`, 16 Tests):
- `/api/tunnel`, `/api/certs` Happy-Path + Error-Pfad
- `/api/network` Snapshot + Throughput-Capping
- `/api/instance` GET/PUT + Validierungs-Pfade
- `/api/notifications/ntfy` redacted-token, leerer Token = unverändert
- `/api/notifications/smtp` redacted-password
- `/api/backups/heatmap`, `/storage-by-guest`

Plus `tests/test_rbac_writes.py` (7 Tests) — RBAC-Gates für Restart + Verify
gegen Viewer/Operator/Admin.

### Restliche dünne Coverage (akzeptabel)
- `app/clients/probes.py` 32 % — bleibt dünn, weil's primär `httpx`-Plumbing
  ist; Logik-Coverage des Probe-Status-Mappings wäre ein Folge-PR.
- `app/notify.py` 66 % — die SMTP-Pfade laufen nur mit echtem Server.

---

## Bewusst NICHT umgesetzt (mit Begründung)

- **`threading.Lock` im Audit-Buffer** (`app/audit.py:21`) — fires < 1µs unter
  GIL, kein Event-Loop-Block in der Praxis bei 200-Eintrag-Deque. Ein
  Wechsel zu `asyncio.Lock` würde die sync `record()`-API kaputt machen
  (wird aus sync HTTPException-Pfaden aufgerufen). Nicht wert.
- **httpx-Client-Pool über Lifespan** statt per-Request — Perf-Optimierung,
  kein Bug. Kann später als eigener Refactor kommen.
- **`proxmox_verify_tls=False` default** — bewusste Entscheidung für
  selbst-signierte interne PVE-Zertifikate; dokumentiert in `.env.example`.

---

## Verifikation

- ✅ `pytest --cov=app` → 196 passed, Coverage 77.8 %
- ✅ Live-Smoke gegen `uvicorn`-Instanz: Login → Session in DB hat **nur**
  `token_hash` + `token_prefix` (keine Plaintext-Spalte), Logout räumt
  die Zeile sauber weg
- ✅ Schema-Migrations-Test simuliert Legacy-DB mit Plaintext-Spalte und
  bestätigt sauberen Drop+Recreate beim Start
