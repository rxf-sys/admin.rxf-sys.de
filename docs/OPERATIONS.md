# Betrieb v2 (Staging und später Produktion)

Gilt für den v2-Neubau auf eigenem LXC (ADR 0001, 0009).

| Rolle | CT | IP |
|---|---|---|
| v2 (dieser Stack) | 113 | 192.168.2.216 |
| v1 (Altcode, `infrastructure/`) | 101 | 192.168.2.202 |
| cloudflared | 110 | 192.168.2.213 |

Öffentlicher Hostname von v2: `admin.rxf-sys.de` (Owner-Entscheidung 19.11.2026). v1 bleibt im LAN unter
`http://192.168.2.202` erreichbar, bis es abgebaut wird.

## Überblick

```text
Browser ─▶ Cloudflare ─▶ cloudflared (CT 110) ─▶ v2-LXC (CT 113) :80 ─▶ web (Caddy, :8080) ─▶ server (Node, :3000)
                                                                     │                        │
                                                        Frontend, Header, /api              /data (Volume)
```

- **Images:** `ghcr.io/rxf-sys/admin-v2-server` und `ghcr.io/rxf-sys/admin-v2-web`.
  - Gebaut werden sie von `ci-v2.yml` bei jedem Push auf `v2`, getaggt als `staging` und `sha-<commit>`.
  - cosign signiert sie ohne Schlüssel, gebunden an diesen Workflow.
- **Pull-Deploy (ADR 0009, Option B):** Ein systemd-Timer im LXC ruft alle 2 min
  `infrastructure-v2/deploy.sh` auf. Das Skript arbeitet diese Schritte ab:
  1. prüft die Signatur des Tags `staging`
  2. zieht die Images per Digest
  3. sichert die Datenbank
  4. startet die Dienste neu
  5. wartet auf die Healthchecks
  6. rollt bei einem Fehler auf die vorherigen Digests zurück

  Einen eingehenden Zugriff, einen Runner im LAN und Deploy-Secrets in GitHub gibt es dabei nicht.
- **Container:**
  - laufen als UID 10001
  - read-only, `cap_drop: ALL`, `no-new-privileges`, `tmpfs` für `/tmp`
  - Speicherlimit: `server` 384 MB, `web` 64 MB
  - Nur das Volume `rxf-admin-v2-data` (`/data`) ist beschreibbar.

## Einmalige Einrichtung

### 1. LXC und Werkzeuge

CT 113 nach ADR 0009 anlegen (IP 192.168.2.216):

- Debian 13, unprivilegiert, `nesting=1,keyctl=1`, `firewall=1`
- 2 Kerne, 1 GB RAM, 16 GB Disk

Darin installieren:

- **Docker CE mit Compose-Plugin** nach <https://docs.docker.com/engine/install/debian/>.
- **cosign:** das Binary aus den Releases von <https://github.com/sigstore/cosign/releases> (z. B.
  `cosign-linux-amd64`), geprüft gegen die `cosign_checksums.txt` desselben Releases:

  ```bash
  V=v3.1.4
  curl -fsSLO "https://github.com/sigstore/cosign/releases/download/$V/cosign-linux-amd64"
  curl -fsSLO "https://github.com/sigstore/cosign/releases/download/$V/cosign_checksums.txt"
  grep ' cosign-linux-amd64$' cosign_checksums.txt | sha256sum -c -
  install -m 0755 cosign-linux-amd64 /usr/local/bin/cosign
  ```
- **jq, git:** `apt-get install -y jq git`

### 2. Repository und Konfiguration

```bash
git clone --branch v2 https://github.com/rxf-sys/admin.rxf-sys.de.git /opt/rxf-admin-v2
cd /opt/rxf-admin-v2/infrastructure-v2
./install.sh               # legt .env an, installiert und startet den Timer
nano .env                  # prüfen: RXF_CLOUDFLARED_IP=192.168.2.213 (CT 110)
```

`RXF_CLOUDFLARED_IP` ist wichtig: Nur von dieser Adresse glaubt Caddy den Header `CF-Connecting-IP`
(Client-IP für Drossel und Audit, ADR 0005). Anfragen anderer Hosts zählen mit ihrer Socket-Adresse.

### 3. Zugriff auf GHCR

Die Images sind Pakete des öffentlichen Repos. Sind sie in GitHub als **öffentlich** markiert
(Paket → Package settings → Change visibility), braucht der LXC keinen Zugang. Sonst einmalig mit einem
Token anmelden, das nur `read:packages` erlaubt:

```bash
docker login ghcr.io -u <github-user>   # Token als Passwort
```

### 4. Erster Deploy und Setup

```bash
systemctl start rxf-admin-v2-deploy     # oder 2 min auf den Timer warten
journalctl -u rxf-admin-v2-deploy -n 50
```

Beim ersten Lauf erzeugt `deploy.sh` den Master-Schlüssel unter `infrastructure-v2/secrets/rxf_master_key`
(UID 10001, Modus 0400). **Diesen Schlüssel sofort getrennt sichern**, etwa im Passwortmanager. Ohne
ihn sind alle Plugin-Secrets und TOTP-Secrets eines Backups wertlos (ADR 0006).

Danach steht der Setup-Code im Log des Servers:

```bash
docker compose logs server | grep "Setup code"
```

Unter `https://admin.rxf-sys.de` (nach Schritt 5) oder vorher per SSH-Tunnel unter `http://localhost:8080` (siehe Schritt 5) den Code eingeben, das Admin-Konto anlegen und den zweiten Faktor
einrichten. Jeder Neustart ohne Admin erzeugt einen neuen Code.

### 5. Tunnel

In Cloudflare Zero Trust beim Tunnel von CT 110 den Public Hostname `admin.rxf-sys.de` von v1
(`http://192.168.2.202:80`) auf v2 umstellen: `http://192.168.2.216:80`. Einen Port nach außen gibt es
nicht.

Ab diesem Moment ist v1 nur noch im LAN erreichbar. Vor dem Umstellen prüfen, ob v2 im LAN läuft
(`curl -s http://192.168.2.216/api/healthz`) und das Admin-Konto eingerichtet ist. Zurück geht es, indem
man den Hostname wieder auf `http://192.168.2.202:80` setzt.

Hinweis zum LAN-Zugriff: Über `http://192.168.2.216` setzt der Browser das Sitzungs-Cookie
(`__Host-`, `Secure`) nicht, weil die Verbindung nicht HTTPS ist. Die Ersteinrichtung geht deshalb nur
über `https://admin.rxf-sys.de` oder über `http://localhost` per SSH-Tunnel
(`ssh -L 8080:127.0.0.1:80 root@192.168.2.216`, dann `http://localhost:8080`). Passkeys lassen sich
nur unter `https://admin.rxf-sys.de` einrichten und nutzen (`RXF_PUBLIC_ORIGIN`), über den Tunnel geht
die Einrichtung mit TOTP.

## Laufender Betrieb

| Aufgabe | Befehl (in `/opt/rxf-admin-v2/infrastructure-v2`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f server` / `journalctl -fu rxf-admin-v2-deploy` |
| Deploy sofort | `systemctl start rxf-admin-v2-deploy` |
| Deploys anhalten | `systemctl stop rxf-admin-v2-deploy.timer` |
| 2FA eines Kontos zurücksetzen | `docker compose exec server node dist/cli.js admin reset-2fa <user>` |
| Konfiguration aus dem Repo aktualisieren | `git -C /opt/rxf-admin-v2 pull` (Compose, Caddy, Deploy-Skript kommen aus dem Checkout) |

Ein Image, dessen Healthchecks fehlschlagen, merkt sich `deploy.sh` in `.deploy-failed` und versucht es
nicht erneut. Erst ein neuer Stand auf `staging` wird wieder ausgerollt.

## Sicherungen

| Was | Wo | Aufbewahrung |
|---|---|---|
| tägliche Kopie (`VACUUM INTO`) | `/data/backups/daily-JJJJ-MM-TT.db` | 14 Tage |
| vor jedem Deploy | `/data/backups/pre-deploy-<ms>.db` | die letzten 10 |
| vor jeder Migration | `/data/backups/pre-migration-<tag>-<ms>.db` | unbegrenzt |
| ganzer LXC | vzdump auf PBS | laut PBS-Plan |
| Master-Schlüssel | getrennt, z. B. Passwortmanager | dauerhaft |

### Wiederherstellen

```bash
cd /opt/rxf-admin-v2/infrastructure-v2
systemctl stop rxf-admin-v2-deploy.timer
docker compose stop server
docker run --rm -v rxf-admin-v2-data:/data --user 10001:10001 --entrypoint sh "$(sed -n 's/^RXF_SERVER_IMAGE=//p' .env)" -c \
  'cp /data/backups/<datei>.db /data/rxf-admin-v2.db && rm -f /data/rxf-admin-v2.db-wal /data/rxf-admin-v2.db-shm'
docker compose start server
systemctl start rxf-admin-v2-deploy.timer
```

Nach einem Rollback auf eine ältere Version gilt: Hat die neuere Version die Datenbank migriert, gehört
die passende `pre-migration-…`-Sicherung zurück. Ältere Versionen kennen das neue Schema nicht.

### Restore-Test

Einmal je Quartal eine `daily-…`-Sicherung in einen Test-Stack laden, zum Beispiel lokal nach dem
Abschnitt unten. Dann anmelden und prüfen, ob die Instanzen ihre Secrets lesen können. Das geht nur mit
dem gesicherten Master-Schlüssel.

## Lokal testen

Der Stack lässt sich mit lokal gebauten Images starten (Docker mit BuildKit):

```bash
docker build -f apps/server/Dockerfile -t rxf-server:local .
docker build -f apps/web/Dockerfile -t rxf-web:local .
mkdir -p /tmp/rxf-stack/secrets && cp infrastructure-v2/compose.yaml /tmp/rxf-stack/
docker run --rm --entrypoint node rxf-server:local dist/cli.js keygen > /tmp/rxf-stack/secrets/rxf_master_key
sudo chown 10001:10001 /tmp/rxf-stack/secrets/rxf_master_key && sudo chmod 0400 /tmp/rxf-stack/secrets/rxf_master_key
printf 'RXF_SERVER_IMAGE=rxf-server:local\nRXF_WEB_IMAGE=rxf-web:local\nRXF_CLOUDFLARED_IP=172.30.10.99\nRXF_PUBLIC_ORIGIN=http://localhost\n' > /tmp/rxf-stack/.env
cd /tmp/rxf-stack && docker compose up -d --wait
```

Hinter einem Proxy ohne Zugriff auf die Debian-Mirrors baut der Server mit `--build-arg OS_UPGRADE=0`.
Mit `--build-arg BUILD_IMAGE=<lokales Node-Image>` lässt sich außerdem ein Build-Image mit eigener
CA einsetzen. Die CI baut immer mit Updates und scannt mit Trivy.
