# Docker (`docker`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt

## Überblick

- **Kategorie:** Container
- **Zweck:** Pro Docker-Host Container mit Status, Health, CPU/RAM und Log-Auszug anzeigen, optional Neustart. Zugriff **ausschließlich über einen Socket-Proxy**, nie über den rohen Docker-Socket und nie über den Daemon-TCP-Port.
- **API:** Docker Engine API (lokal, HTTP, kein Cloud-Dienst). moby-`master` steht bei `info.version: 1.57` / `basePath: /v1.57` [D]. Zuordnung laut Doku-Tabelle: Docker 25.0 → 1.44, 27.0 → 1.46, 28.0 → 1.48, 29.0/29.1 → 1.52, 29.2 → 1.53, 29.3–29.5 → 1.54, 29.6–29.8 → 1.55 [D]. Neuester Engine-Release: 29.9.1 (14.10.2026) [D].
- **Untergrenze:** „API versions before v1.40 are deprecated and no longer supported“ [D]. Docker 29.0.0 verlangte API ≥ v1.44, 29.3.0 senkte das Minimum wieder auf v1.40 [D]. Plugin-Ziel: **Docker ≥ 25.0 (API ≥ 1.44)** voll unterstützt, 1.40–1.43 best effort.
- **Modell:** Eine Plugin-Instanz je Docker-Host (Empfehlung, siehe Offene Punkte). Mehrere Hosts = mehrere Instanzen.

## Verbindung & Auth

### Netzwerk-Varianten (Proxy hat selbst keine Auth und kein TLS)

| Variante | Aufbau | Bewertung | Quelle |
|---|---|---|---|
| A – lokal | Proxy im selben Compose-Projekt wie das Dashboard, **ohne** `ports:`, nur internes Netz | Beste Isolation, nur für den Host, auf dem v2 selbst läuft | [D] (Tecnativa: „only on a Docker network with the proxy and the consumer“) |
| B – LAN + Firewall (**Standard**) | Proxy auf dem Docker-Host, `ports: "<LAN-IP>:2375:2375"`, Proxmox-Firewall am CT lässt 2375/tcp nur von der v2-LXC-IP zu | Einfach; Klartext-HTTP im LAN; Schutz rein über Netzwerkisolation | [D]/[A] |
| C – mTLS-Sidecar | Proxy nur intern, davor TLS-Terminator mit Client-Zertifikatsprüfung (z. B. ghostunnel, stunnel, Caddy) | Stärkste Variante, mehr Setup | [?] (Designvorschlag) |
| D – Overlay | Proxy nur auf WireGuard-/Tailscale-IP binden | Gut bei verteilten Hosts | [?] |
| verboten | Daemon-TCP (2375/2376 mit `tlsverify`) oder Socket-Mount ins Dashboard | Volle API ohne Filter = root auf dem Host | [D] |

- Docker selbst: „only trusted users should be allowed to control your Docker daemon“, Zugriff auf die TLS-Client-Keys ist „root access to the machine“, Endpunkte nur aus „trusted network or VPN“ [D].
- Tecnativa: „no TLS support“, Port nie in ein öffentliches Netz [D]. linuxserver: „treat the same way you would treat the docker socket“, kein TLS erwähnt [D].
- **Firewall gehört außerhalb des LXC:** Von Docker veröffentlichte Ports umgehen `ufw` („traffic … gets diverted before it goes through the ufw firewall settings“) [D]. Deshalb Proxmox-Firewall auf CT-Ebene nutzen; `firewall=1` ist am `net0` des Alt-CT bereits gesetzt (`infrastructure/setup-lxc.sh:57`) [A].
- **Restrisiko Variante B:** Wer im LAN die v2-IP spoofen kann oder den v2-LXC kompromittiert, liest alle Container-Konfigurationen inkl. `Config.Env` (Umgebungsvariablen = oft Secrets) [D Feld]. Mit Aktionen zusätzlich Stop/Kill aller Container.

### Protokoll

- Basis-URL: `http://<host>:2375` (beide Proxys lauschen fest auf 2375; linuxserver bindet `[::]:2375 v4v6`, mit `DISABLE_IPV6=1` nur `:2375`) [D].
- Kein Auth-Header. Die Engine-API kennt nur `X-Registry-Auth` für Registries [D]. Optionaler `Authorization`-Header nur für Variante C mit vorgeschaltetem Reverse-Proxy [?].
- **Versionierung:** Pfad-Präfix `/v1.xx/…`; ohne Präfix gilt die aktuelle Version, das ist laut Spec „deprecated“; nicht unterstützte Version → HTTP 400 [D]. Beide Proxys akzeptieren `(/v[\d\.]+)?` vor jedem Pfad [D].
- **Aushandlung (wie Docker-CLI):** `GET /_ping` → Header `Api-Version` (= Max-Version des Servers) [D]; `GET /version` → `ApiVersion`, `MinAPIVersion` [D]. Plugin nutzt `min(Server-Max, höchste getestete Version)`, mindestens 1.40 [D] (Negotiation-Prinzip aus Doku).
- **TLS:** Variante B ohne TLS. Variante C: eigene CA üblich → Fingerprint-Pinning (TOFU) des Server-Zertifikats + Client-Zertifikat [?].

### Entwurf `configSchema`

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `name` | string | ja | nein | Anzeigename des Docker-Hosts, z. B. „CT 110 admin“ |
| `baseUrl` | url (`http`/`https`) | ja | nein | URL des Socket-Proxys, z. B. `http://192.168.2.210:2375`. Niemals Daemon-Port oder `unix://` |
| `apiVersion` | enum `auto` \| `1.44` … `1.57` | nein | nein | Standard `auto` (aushandeln) |
| `tlsFingerprint` | string (SHA-256) | nein | nein | Nur bei `https`; wird beim ersten Test per TOFU vorgeschlagen |
| `clientCert` | PEM | nein | nein | Nur Variante C (mTLS) |
| `clientKey` | PEM | nein | **ja** | Nur Variante C (mTLS) |
| `authHeader` | string | nein | **ja** | Nur wenn ein vorgeschalteter Reverse-Proxy Basic/Bearer verlangt |
| `includeStopped` | boolean | nein | nein | Auch gestoppte Container zeigen (`all=true`), Standard `true` |
| `statsMode` | enum `off` \| `watched` \| `always` | nein | nein | CPU/RAM nur abfragen, wenn jemand hinsieht (Standard `watched`) |
| `statsConcurrency` | int 1–8 | nein | nein | Parallele Stats-Abfragen, Standard 4 |
| `logsEnabled` | boolean | nein | nein | Log-Auszug anbieten (Proxy braucht `ALLOW_LOGS=1`), Standard `false` |
| `logTailLines` | int 10–500 | nein | nein | Zeilen im Log-Auszug, Standard 100 |
| `protectedContainers` | string[] | nein | nein | Namen/Labels, die nie neu gestartet werden (Vorbelegung: `socket-proxy`, `cloudflared`, das Dashboard selbst) |
| `hideContainers` | string[] | nein | nein | Container ausblenden (Name oder `label=…`) |

## Minimale Rechte

### Proxy-Wahl: linuxserver statt Tecnativa

| Aspekt | `tecnativa/docker-socket-proxy` | `lscr.io/linuxserver/socket-proxy` | Quelle |
|---|---|---|---|
| Stand | v0.5.0 (27.07., Jahr auf Seite nicht angezeigt) | Changelog 18.08.26 | [D] |
| Basis | `haproxy:3.4.2-alpine` | Alpine 3.24 + HAProxy (seit 06.04.25 wieder HAProxy) | [D] |
| Standardmäßig an | `EVENTS`, `PING`, `VERSION` | `EVENTS`, `PING`, `VERSION` (+ `LIBPOD_PING`, `LIBPOD_VERSION`) | [D] |
| Logs | in `CONTAINERS` enthalten | eigener Schalter `ALLOW_LOGS` (seit 18.08.26) | [D] |
| `archive`/`export`/`top`/`changes` | in `CONTAINERS` enthalten → `GET /containers/{id}/archive` liest Dateien aus jedem Container | eigene Schalter `ALLOW_ARCHIVE`/`ALLOW_EXPORT`/`ALLOW_TOP`/`ALLOW_CHANGES`, Standard 0 | [D] (aus `haproxy.cfg` abgeleitet) |
| Neustart ohne `POST=1` | **nein:** `http-request deny unless METH_GET \|\| { env(POST) -m bool }` steht vor den `ALLOW_*`-Regeln | **ja:** `ALLOW_START/STOP/RESTARTS` „work even with `POST=0`“ (26.08.24), Regeln stehen vor der Methodenprüfung | [D] |
| Folge von `POST=1` + `CONTAINERS=1` | alle Methoden auf `^(/v…)?/containers` erlaubt, inkl. `POST /containers/create` + `/start` → privilegierter Container → root auf dem Host | entfällt, `POST` bleibt 0 | [D] (abgeleitet) |
| `/events`-Stream | eigenes Backend mit `timeout server 0` | kein Sonder-Backend, `timeout server 10m` | [D] |
| Härtung | – | `read_only: true` + `tmpfs: /run` dokumentiert; amd64/arm64/riscv64 | [D] |

**Entscheidung:** linuxserver/socket-proxy. Nur damit ist „lesen + Neustart“ ohne `POST=1` möglich, und Logs/Datei-Export lassen sich getrennt sperren. Tecnativa nur akzeptabel für reines Lesen; dann sind Logs und `archive` aber automatisch mit freigegeben.

### Nur lesen

```yaml
# docker-compose.yml auf jedem Docker-Host
services:
  socket-proxy:
    image: lscr.io/linuxserver/socket-proxy:<version>   # Version pinnen
    container_name: socket-proxy
    environment:
      - CONTAINERS=1     # /containers/json, /{id}/json, /{id}/stats
      - INFO=1           # /info (Host-Kennzahlen)
      - ALLOW_LOGS=0     # 1 = Log-Auszug erlauben (optional)
      # Defaults bewusst so lassen: EVENTS=1 PING=1 VERSION=1 POST=0, alles andere 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    read_only: true
    tmpfs:
      - /run
    ports:
      - "192.168.2.210:2375:2375"   # nur LAN-IP des Hosts, nie 0.0.0.0
    restart: unless-stopped
```

- Alle übrigen Sektionen bleiben 0 (`AUTH`, `BUILD`, `COMMIT`, `CONFIGS`, `DISTRIBUTION`, `EXEC`, `IMAGES`, `NETWORKS`, `NODES`, `PLUGINS`, `SECRETS`, `SERVICES`, `SESSION`, `SWARM`, `SYSTEM`, `TASKS`, `VOLUMES`, alle `ALLOW_*`) [D].
- `:ro` am Socket-Mount ist kein Schutz für API-Aufrufe; filtern tut nur der Proxy [?].
- Restrisiko trotz `POST=0`: `GET /containers/{id}/json` liefert `Config.Env` [D]; `GET /containers/{id}/attach/ws` ist ein **GET**-Websocket mit `stdin`-Parameter [D] und wird von keinem der beiden Proxys gesondert gefiltert [D]. Ob darüber bei Containern mit `OpenStdin` geschrieben werden kann, ist ungetestet [?]. Gegenmittel: Netzwerkisolation (Variante A–D).

### Zusätzlich für Aktionen

| Env (linuxserver) | Erlaubt | Bemerkung | Quelle |
|---|---|---|---|
| `ALLOW_RESTARTS=1` | `POST /containers/{id}/stop`, `/restart`, `/kill` | Nicht feiner trennbar: Wer Neustart erlaubt, erlaubt auch Stop und Kill | [D] |
| `ALLOW_START=1` | `POST /containers/{id}/start` | Nur nötig, falls später „Starten“ kommt | [D] |
| `POST` | bleibt **0** | – | [D] |

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

Docker kennt kein Token. Die Rechte legt allein die Konfiguration des Socket-Proxys fest, deshalb führt der Assistent durch dessen Einrichtung.

1. Auf dem Docker-Host (z. B. `pct enter 110`) ein Verzeichnis `/opt/socket-proxy` anlegen und den Compose-Block oben als `docker-compose.yml` speichern. LAN-IP in `ports:` eintragen. `[Screenshot: Compose-Datei im Editor]`
2. Für Neustart-Aktionen zusätzlich `ALLOW_RESTARTS=1` setzen; für Log-Auszug `ALLOW_LOGS=1`. Der Assistent zeigt den Block passend zu den gewählten Optionen an.
3. `docker compose up -d` ausführen; `docker compose logs socket-proxy` darf keine Fehler zeigen. `[Screenshot: Terminal mit laufendem Proxy]`
4. In Proxmox unter *CT → Firewall → Regeln* eine Regel „IN ACCEPT, Quelle `<v2-LXC-IP>`, Proto tcp, Port 2375“ anlegen, danach eine DROP-Regel für Port 2375 von allen anderen Quellen; Firewall des CT aktivieren. `[Screenshot: PVE-Firewall-Regeln]`
5. Im Dashboard *Plugins → Docker → Hinzufügen*: Name und `http://<LAN-IP>:2375` eintragen. `[Screenshot: Formular]`
6. „Verbindung testen“ klicken. Der Test prüft zusätzlich, ob der Endpunkt **zu viel** erlaubt (roher Socket, `POST=1`) und bricht dann ab.
7. Optional „Aktionen aktivieren“ → Rolle `operator` und geschützte Container wählen.
8. Herstellerdoku verlinken: https://github.com/linuxserver/docker-socket-proxy · https://docs.docker.com/engine/security/protect-access/

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Erreichbarkeit, Max-API | `GET /_ping` → `OK`, Header `Api-Version` | `Host.status` | 30 s / 5 min | [D] |
| Engine-Version | `GET /version` → `Version`, `ApiVersion`, `MinAPIVersion`, `Os`, `Arch`, `KernelVersion` | `Host` | beim Test + 1 h | [D] |
| Host-Kennzahlen | `GET /v1.xx/info` → `Name`, `ServerVersion`, `Containers`, `ContainersRunning`, `ContainersPaused`, `ContainersStopped`, `Images`, `NCPU`, `MemTotal`, `OperatingSystem`, `CgroupVersion`, `Warnings` | `Host` | 60 s / 10 min | [D] |
| Containerliste | `GET /v1.xx/containers/json?all=true` → `Id`, `Names`, `Image`, `ImageID`, `Created`, `Ports`, `Labels`, `State`, `Status`, `Mounts`, `Health` (ab 1.52) | `Guest` (Art `container`) | 15 s / 2 min, plus sofort bei Event | [D] |
| Health vor API 1.52 | `filters={"health":["unhealthy","starting"]}` auf derselben Liste, oder `GET /containers/{id}/json` | `Guest.status` | mit Liste | [D] |
| Container-Detail | `GET /v1.xx/containers/{id}/json` → `State` (`Status`, `ExitCode`, `OOMKilled`, `StartedAt`, `FinishedAt`, `Health.Status`, `Health.FailingStreak`, `Health.Log[]`), `RestartCount`, `HostConfig.RestartPolicy` | `Guest` | on demand + bei Statuswechsel | [D] |
| CPU/RAM/Netz/IO | `GET /v1.xx/containers/{id}/stats?stream=false&one-shot=true` (ab 1.41) → `cpu_stats`, `memory_stats`, `networks`, `blkio_stats`, `pids_stats` | `Metric` | 15 s nur bei Ansicht / aus | [D] |
| Log-Auszug | `GET /v1.xx/containers/{id}/logs?stdout=true&stderr=true&tail=100&timestamps=true` | – (nur Seite) | on demand, nie im Hintergrund | [D] |
| Live-Änderungen | `GET /v1.xx/events?filters={"type":["container"]}` (Stream) → `Type`, `Action`, `Actor.ID`, `Actor.Attributes`, `time`, `timeNano` | löst Refresh aus | Dauerverbindung | [D] |

**Statusabbildung** (Vorschlag) [?]: `running` + Health `healthy`/`none` → `ok`; `running` + `starting` → `warn`; `running` + `unhealthy` → `crit`; `restarting` → `warn`; `paused` → `paused`; `exited` mit `ExitCode` 0 und `RestartPolicy` `no`/`on-failure` → `ok` (erwartet beendet); sonst `exited` → `crit`; `dead` → `crit`; `created`/`removing` → `unknown`. Enum-Werte `State` und `Health.Status` [D].

**CPU/RAM-Berechnung** (aus der Spec) [D]: `used_memory = memory_stats.usage - memory_stats.stats.inactive_file` (cgroup v2; v1: `.cache`), `available_memory = memory_stats.limit`, `cpu_delta / system_cpu_delta * number_cpus * 100`. Mit `one-shot=true` fehlt `precpu_stats` [D] → CPU % aus den Differenzen zweier eigener Polls (`cpu_usage.total_usage`, `system_cpu_usage`) rechnen [?].

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Container neu starten | `POST /v1.xx/containers/{id}/restart?t=10` → 204 / 404 / 500 | `medium` | `operator` | `ALLOW_RESTARTS=1` | [D] |
| Neustart eines Infrastruktur-Containers (Proxy, `cloudflared`, Dashboard selbst, DNS) | wie oben | `high` | `admin` (Standard: gesperrt über `protectedContainers`) | `ALLOW_RESTARTS=1` | [D]/[?] |
| Container starten (später, nicht MVP) | `POST /v1.xx/containers/{id}/start` | `low` | `operator` | `ALLOW_START=1` | [D] |
| Stop / Kill | – (bewusst nicht angeboten, obwohl `ALLOW_RESTARTS` sie technisch freigibt) | `high` | – | – | [D] |

Audit-Text: „{user} hat Container {name} auf {host} neu gestartet (Timeout {t} s)“. Parameter-Schema: `{ t: int 0–120, Standard 10 }`. Den ebenfalls vorhandenen Parameter `signal` [D] nicht exponieren.

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| Container-Zähler | laufend / gestoppt / unhealthy je Host | S |
| Problem-Container | nur `unhealthy`, `restarting`, unerwartet `exited` | S, M |
| Container-Liste | Name, Image, Status, Health, Laufzeit, CPU %, RAM | M, L, XL |
| Ressourcen-Top-N | höchste CPU/RAM-Nutzung (nur wenn `statsMode` ≠ `off`) | M, L |
| Docker-Host | Engine-Version, API, `NCPU`, `MemTotal`, Containerzahlen, `Warnings` | S, M |
| Ereignis-Ticker | letzte `die`, `oom`, `health_status`, `restart` | M, L |

### Seiten (Vorschlag)

- **Docker-Hosts:** alle Instanzen mit Zählern und Engine-Versionen.
- **Container-Detail:** Status, Health-Verlauf aus `State.Health.Log` (letzte Prüfungen mit `ExitCode`/`Output`) [D], Ports, Labels, Mounts (ohne Env!), Stats-Verlauf, Log-Auszug (stdout/stderr getrennt, Download), Button „Neu starten“.
- **Gruppierung nach Compose-Projekt** über Label `com.docker.compose.project` [?].

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Container unhealthy | `Health.Status == unhealthy` in 2 Polls hintereinander oder Event `health_status` | `crit` |
| Unerwartet beendet | `State == exited`, `ExitCode ≠ 0` oder `RestartPolicy` ∈ {`always`, `unless-stopped`}; bzw. Event `die` | `crit` |
| Neustart-Schleife | `State == restarting` oder ≥ 3 Events `die`/`restart` in 10 min | `crit` |
| OOM | Event `oom` oder `State.OOMKilled == true` | `warn` |
| RAM am Limit | `used_memory / limit > 90 %` für 10 min (nur wenn ein Limit gesetzt ist) | `warn` |
| Docker-Host weg | `/_ping` 3× fehlgeschlagen | `crit` |
| Engine-API veraltet | `ApiVersion < 1.44` | `warn` |
| Proxy zu offen | Verbindungstest meldet `PROXY_TOO_PERMISSIVE` | `crit` |

## Rate-Limits & Last

- Keine Rate-Limits (lokale API); in der Spec ist nichts dokumentiert [?].
- **Stats sind der Kostentreiber:** ein Request pro Container. `stream=false` ohne `one-shot` wartet laut Spec auf zwei Messzyklen („instead of waiting for 2 cycles“) [D] → spürbare Latenz pro Container. Deshalb: `one-shot=true`, Parallelität begrenzen (`statsConcurrency`), nur bei Ansicht abfragen, im Hintergrund aus.
- `size=true` (Liste und Inspect) liefert `SizeRw`/`SizeRootFs` [D]; nicht verwenden, gilt als teuer [?].
- **Events statt Polling:** eine Dauerverbindung je Host senkt das Listen-Intervall im Hintergrund. linuxserver hat `timeout server 10m` ohne Ausnahme für `/events` [D] → bei ruhigen Hosts Abbruch nach Leerlauf; mit `since=<letzter timeNano>` neu verbinden.
- Logs immer mit `tail` und Byte-Obergrenze, nie `follow=true` im MVP.
- Deduplizierung: Liste und `/info` einmal pro Host und Intervall, alle Widgets lesen den Cache. Ein toter Host blockiert andere nicht (eigener Circuit-Breaker je Instanz).

## Verbindungstest & Fehlercodes

Ablauf: `/_ping` → `/version` (API aushandeln) → `/info` → `/containers/json?limit=1` → optional Logs/Restart → **Gegenprobe auf zu viele Rechte**. Proxy-403 (HAProxy-Fehlerseite) von Docker-Fehlern (JSON mit `message`) über `Content-Type` unterscheiden [D Fehlerformat].

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH` | „Socket-Proxy unter {url} nicht erreichbar. Läuft der Container, ist Port 2375 auf der LAN-IP veröffentlicht und die Firewall für dieses Dashboard offen?“ |
| `NOT_DOCKER` | `/_ping` liefert nicht `OK` oder kein Header `Api-Version` | „Unter dieser Adresse antwortet keine Docker-API.“ |
| `API_TOO_OLD` | `ApiVersion < 1.40` (Warnung bei < 1.44) | „Docker {Version} (API {ApiVersion}) ist zu alt. Unterstützt wird ab Docker 25.0.“ |
| `API_VERSION_REJECTED` | HTTP 400 auf versionierten Pfad | „Der Docker-Host lehnt API-Version {v} ab. Bitte ‚auto‘ wählen.“ |
| `PROXY_DENIED_INFO` | 403 (HTML) auf `/info` | „Der Socket-Proxy blockiert /info. Bitte `INFO=1` setzen.“ |
| `PROXY_DENIED_CONTAINERS` | 403 (HTML) auf `/containers/json` | „Der Socket-Proxy blockiert /containers. Bitte `CONTAINERS=1` setzen.“ |
| `PROXY_DENIED_LOGS` | 403 auf `/containers/{id}/logs?tail=1` (nur wenn `logsEnabled`) | „Log-Auszug ist im Proxy gesperrt. Bitte `ALLOW_LOGS=1` setzen (linuxserver ab 18.08.26).“ |
| `PROXY_DENIED_RESTART` | 403 auf `POST /containers/rxf-probe-<zufall>/restart` (nur wenn Aktionen an); 404 = erlaubt | „Neustart ist im Proxy gesperrt. Bitte `ALLOW_RESTARTS=1` setzen.“ |
| `PROXY_TOO_PERMISSIVE` | `GET /images/json?filters={"reference":["rxf-probe-<zufall>"]}` → 200, **oder** `POST /containers/rxf-probe-<zufall>/rename?name=x` → 404 statt 403 | „Der Endpunkt erlaubt mehr als nötig (roher Docker-Socket oder `POST=1`). Aus Sicherheitsgründen wird er nicht verwendet. Bitte linuxserver/socket-proxy mit den angezeigten Variablen einsetzen.“ (Test schlägt fehl) |
| `TLS_FINGERPRINT_MISMATCH` | Zertifikat ≠ gepinnter Fingerprint | „Das Zertifikat des Docker-Hosts hat sich geändert. Bitte prüfen und neu bestätigen.“ |
| `TLS_CLIENT_CERT_REJECTED` | TLS-Alert beim Handshake | „Das Client-Zertifikat wurde abgelehnt.“ |
| `DOCKER_ERROR` | 500 mit JSON `message` | „Docker meldet einen Fehler: {message}“ |

Die Probe-Requests zielen auf einen garantiert nicht existierenden Container (Zufallsname); erlaubt der Endpunkt sie, antwortet Docker nur mit 404 [?].

## Eigenheiten & Stolperfallen

- **`Health` in der Liste erst ab API 1.52** („before that version all container summary not include Health“) [D]. Davor Filter `health=…` oder Inspect je Container [D]. `Status` ist nur Freitext („Up 4 days“) [D].
- **Container-ID ändert sich bei Neuerstellung** (`docker compose up` nach Image-Update). Für stabile Historie `externalId` aus Host + Compose-Projekt/Service-Label bzw. Name bilden, `Id` nur als Attribut [?].
- `Names` enthalten einen führenden `/` [?].
- **Logs:** multiplexed, wenn der Container kein TTY hat. Seit 1.42 zeigt `Content-Type` `application/vnd.docker.multiplexed-stream` bzw. `application/vnd.docker.raw-stream` an [D]. Frame-Header: 8 Byte `{STREAM_TYPE, 0, 0, 0, SIZE1..SIZE4}`, Größe `uint32` big endian, `STREAM_TYPE` 1 = stdout, 2 = stderr [D]. Zeilen können über Frames verteilt sein.
- Logs nur für Log-Driver `json-file` und `journald` [D]. Logs und Env können Secrets enthalten → Log-Auszug standardmäßig erst ab Rolle `operator` [?].
- **Events:** Seit 1.52 fehlen die alten Felder `status`, `id`, `from`; Content-Negotiation `application/x-ndjson` oder `application/json-seq`, seit 1.53 auch `application/jsonl` [D]. Container-Events u. a. `create`, `destroy`, `die`, `health_status`, `kill`, `oom`, `pause`, `restart`, `start`, `stop`, `prune` [D]. Format des `Action`-Werts bei `health_status` (mit Suffix?) [?].
- **cgroup v2:** `percpu_usage`, `max_usage`, `failcnt` fehlen; `online_cpus` nutzen [D]. Ohne Speicherlimit liefert `memory_stats.limit` vermutlich den RAM des Hosts bzw. LXC [?].
- **Stats bei gestoppten Containern** nicht abfragen (Ergebnis leer bzw. Nullwerte) [?].
- `ALLOW_RESTARTS` gibt auch `stop` und `kill` frei [D]; ein gestoppter Container ist ohne `ALLOW_START` aus dem Dashboard nicht wieder startbar.
- **Docker in Proxmox-LXC:** Alt-CT ist unprivilegiert mit `nesting=1,keyctl=1` [A]. Proxmox empfiehlt für Anwendungscontainer weiterhin eine QEMU-VM als „recommended practice“ (Isolation, Live-Migration) [D]. Tecnativa nennt `--privileged` für SELinux/AppArmor [D]; im LXC nicht verwenden. linuxserver nennt nur für SELinux `--security-opt label=disable` [D].
- Docker 29.0–29.2 lehnten Clients < 1.44 ab [D]; Fehlermeldung „client version … is too old“ und serverseitiger Workaround `DOCKER_MIN_API_VERSION` [S]. Das Plugin verhandelt selbst, ist also nicht betroffen.
- Selbst-Neustart: Startet das Dashboard seinen eigenen Container oder den Proxy neu, reißt die Verbindung ab. Deshalb Vorbelegung in `protectedContainers` [?].

## Wissen aus dem Altcode

**Keine Altintegration.** `backend/app` spricht nirgends mit Docker; der einzige Treffer ist ein Kommentar in `backend/app/config.py:51` [A]. Relevante Deployment-Fakten:

- Alt-App läuft als Compose-Stack in CT 110 (`192.168.2.210`, unprivilegiertes Debian 12, `nesting=1,keyctl=1`, `firewall=1`), Docker CE + Compose-Plugin aus `download.docker.com` (`infrastructure/setup-lxc.sh:16-18`, `51-62`, `81-91`) [A].
- Container `rxf-admin-backend` (Healthcheck alle 30 s gegen `/api/health`, `retries: 3`) und `rxf-admin-web` (Port `80:80` auf allen Interfaces), Netz `admin` (bridge), Volume `rxf-admin-data` (`infrastructure/docker-compose.yml:2-47`) [A].
- `deploy.sh` wartet per `docker inspect --format '{{.State.Health.Status}}' rxf-admin-backend` bis zu 30 × 2 s auf `healthy` (`infrastructure/deploy.sh:32-42`) [A]. Genau dieses Feld nutzt das Plugin; `rxf-admin-backend` ist ein guter realer Testfall.
- `cloudflared` läuft in CT 104 und zeigt auf `http://192.168.2.210:80` (`infrastructure/setup-lxc.sh:124-125`, `docker-compose.yml:37`) [A].
- v2 läuft in einem **eigenen LXC** (`docs/adr/0001-kickoff-decisions.md`, Abschnitt 6) [A]. CT 110 ist damit ein entfernter Host → Variante B ist mindestens dort nötig.

## Testbarkeit (Vertragstests)

- **Offizielle Spec:** `moby/moby` → `api/swagger.yaml` (aktuell 1.57) und versionierte Specs `api/docs/v1.25.yaml` … `v1.56.yaml` [D]. Damit lassen sich Typen/Zod-Schemas erzeugen und Fixtures gegen 1.44 und 1.52 validieren.
- **Fixtures aufnehmen** (anonymisiert, Env entfernt): `/_ping`-Header, `/version`, `/info`, `/containers/json` mit API 1.51 (ohne `Health`) und 1.52 (mit `Health`), Inspect von `rxf-admin-backend` mit `State.Health.Log`, Stats `one-shot` unter cgroup v2, Logs multiplexed und raw (TTY), Events als NDJSON, HAProxy-403-Seite von linuxserver.
- **Mock:** Fastify-Testserver mit Frame-Builder für multiplexed Streams; Event-Stream mit künstlichem Abbruch nach Leerlauf.
- Optionaler Integrationsjob: echter Docker im CI-Runner + linuxserver-Proxy + Testcontainer mit Healthcheck. Das ist kein reales Gerät, also vereinbar mit „CI trifft keine Geräte“ [?].
- Altcode-Fixtures: keine [A].

## Aufwand & Empfehlung

- **Aufwand: M.** REST-Teil ist einfach und gut spezifiziert. Aufwand entsteht durch Stream-Parsing (Logs multiplexed, Events mit Reconnect), Kostensteuerung der Stats, API-Aushandlung 1.40–1.57, die Gegenprobe auf zu weite Rechte, Mehr-Host-Betrieb und optional mTLS.
- **Abhängigkeiten:** SDK mit Dauer-Collectors (Events), `Metric`-Zeitreihen, Aktionsvertrag + Audit, Instanz-Modell (mehrere Hosts), TLS-Pinning.
- **Empfohlene Welle:** erstes Plugin der Welle 2 (neue Plugins). Es ist komplett lokal testbar und liefert sofort Nutzen für CT 110.

## Offene Punkte

1. Welche Docker-Hosts gibt es außer CT 110 (Owner)?
2. Läuft v2 selbst in Docker? Dann Variante A für den eigenen Host.
3. Reicht Variante B (LAN + Proxmox-Firewall, Klartext) oder ist mTLS (Variante C) Pflicht?
4. Für welche Container ist Neustart erlaubt, welche sind standardmäßig geschützt?
5. Dürfen `viewer` den Log-Auszug sehen?
6. Instanz je Host oder eine Instanz mit Endpunktliste? Das entscheidet das Plugin-SDK-ADR.
7. Podman-Unterstützung über `LIBPOD_*` des linuxserver-Proxys [D]? Vorschlag: nicht im MVP.
8. Stabile `externalId` über Neuerstellungen hinweg (Compose-Labels) abstimmen.

## Quellen

1. https://raw.githubusercontent.com/moby/moby/master/api/swagger.yaml – Version 1.57, Versionierung/400, `ContainerSummary` (inkl. `Health` ab 1.52), `ContainerState`, `Health`, `HealthcheckResult`, `RestartPolicy`, Parameter von `containers/json`, `logs`, `stats` (Formeln, `one-shot`), `restart`, `events`, `_ping`-Header, Attach-Stream-Format, `attach/ws` (GET), `archive`, `ContainerConfig.Env`, `ContainerInspectResponse`, `EventMessage`, `ContainerStatsResponse`
2. https://github.com/moby/moby/tree/master/api/docs – versionierte Specs v1.25–v1.56
3. https://raw.githubusercontent.com/moby/moby/master/api/docs/CHANGELOG.md – Änderungen 1.41 (`one-shot`), 1.42 (Content-Type Logs), 1.52 (Events, Stats `os_type`), 1.53 (jsonl), 1.56
4. https://raw.githubusercontent.com/docker/docs/main/content/reference/api/engine/_index.md – Versionsmatrix Docker → API, „before v1.40 deprecated“, Aushandlung
5. https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/release-notes/29.md – Minimum 1.44 in 29.0.0, 1.40 ab 29.3.0, Releases bis 29.9.1
6. https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/security/_index.md – nur vertrauenswürdige Nutzer, Netz/VPN
7. https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/security/protect-access.md – TLS 2376, root-Äquivalenz, SSH
8. https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/network/packet-filtering-firewalls.md – Ports umgehen ufw
9. https://raw.githubusercontent.com/Tecnativa/docker-socket-proxy/master/README.md – Variablen, Defaults, kein TLS, Warnungen
10. https://raw.githubusercontent.com/Tecnativa/docker-socket-proxy/master/haproxy.cfg – Regelreihenfolge (Methodenprüfung zuerst), Events-Backend
11. https://raw.githubusercontent.com/Tecnativa/docker-socket-proxy/master/Dockerfile – Defaults, Basisimage, Port 2375
12. https://github.com/Tecnativa/docker-socket-proxy/releases – v0.5.0
13. https://raw.githubusercontent.com/linuxserver/docker-socket-proxy/main/README.md – Variablen inkl. `ALLOW_LOGS`, Changelog, Compose-Beispiel, read_only/tmpfs
14. https://raw.githubusercontent.com/linuxserver/docker-socket-proxy/main/root/templates/haproxy.cfg – Regelreihenfolge, `ALLOW_*`-Denies, Timeouts
15. https://raw.githubusercontent.com/linuxserver/docker-socket-proxy/main/root/docker-entrypoint.sh – Bind `[::]:2375 v4v6`
16. https://raw.githubusercontent.com/proxmox/pve-docs/master/pct.adoc – Anwendungscontainer in VM als „recommended practice“, Nesting
17. https://www.docker.com/blog/docker-engine-version-29/ – `DOCKER_MIN_API_VERSION` (nur Suche) [S]
18. Altcode: `infrastructure/setup-lxc.sh`, `infrastructure/docker-compose.yml`, `infrastructure/deploy.sh`, `backend/app/config.py:51`, `docs/adr/0001-kickoff-decisions.md`
