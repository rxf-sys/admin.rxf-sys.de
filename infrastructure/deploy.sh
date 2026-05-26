#!/usr/bin/env bash
#
# deploy.sh — Docker-Compose-Deploy für admin.rxf-sys.de
#
# Wird von der CD-Pipeline (GitHub Actions via SSH) oder manuell aufgerufen.
# Installationspfad: /opt/rxf-admin/infrastructure/deploy.sh
# Versioniert im Repo — Änderungen werden beim nächsten Deploy automatisch aktiv.
#
set -euo pipefail

REPO_DIR="/opt/rxf-admin"
BRANCH="main"

cd "$REPO_DIR"

echo "[deploy] $(date --iso-8601=seconds) — sync ${BRANCH}"

git fetch --prune origin "$BRANCH"
git reset --hard "origin/${BRANCH}"

echo "[deploy] Rebuilding containers..."
cd infrastructure
docker compose up -d --build

echo "[deploy] OK — HEAD $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
docker compose ps
