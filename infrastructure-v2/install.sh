#!/usr/bin/env bash
# One-time setup inside the v2 LXC (docs/OPERATIONS.md). Idempotent; changes nothing that already exists.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

for tool in docker cosign jq flock; do
  command -v "$tool" >/dev/null || { echo "install.sh: $tool is missing (docs/OPERATIONS.md, step 1)"; exit 1; }
done
docker compose version >/dev/null

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "install.sh: created $PWD/.env - set RXF_CLOUDFLARED_IP before the first deploy"
fi
install -m 0644 systemd/rxf-admin-v2-deploy.service systemd/rxf-admin-v2-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rxf-admin-v2-deploy.timer
echo "install.sh: timer active; follow the first deploy with: journalctl -fu rxf-admin-v2-deploy"
