#!/usr/bin/env bash
# Pull deploy of the v2 stack (ADR 0009, option B), run by rxf-admin-v2-deploy.timer every 2 minutes:
# verify the signature of the images behind the tag, pull them by digest, back up the database, restart,
# wait for the health checks and roll back to the previous digests if they fail.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

REGISTRY="${RXF_REGISTRY:-ghcr.io/rxf-sys}"
TAG="${RXF_TAG:-staging}"
# Only images signed by this repository's CI workflow on the v2 branch are accepted.
IDENTITY="${RXF_SIGNER:-https://github.com/rxf-sys/admin.rxf-sys.de/.github/workflows/ci-v2.yml@refs/heads/v2}"
ISSUER="https://token.actions.githubusercontent.com"
ENV_FILE=.env
KEY_FILE=secrets/rxf_master_key
# Digests that failed their health checks; the timer does not retry them until the tag moves on.
FAILED_FILE=.deploy-failed
KEEP_PRE_DEPLOY=10

log() { echo "rxf-deploy: $*"; }

exec 9>"${RXF_LOCK_FILE:-/run/lock/rxf-admin-v2-deploy.lock}"
flock -n 9 || exit 0

[[ -f "$ENV_FILE" ]] || { log "missing $PWD/$ENV_FILE (copy .env.example)"; exit 1; }

# Prints the digest the tag points to, after cosign has checked its signature against the workflow identity.
verified_digest() {
  local ref="$REGISTRY/admin-v2-$1:$TAG"
  cosign verify --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" "$ref" 2>/dev/null \
    | jq -er '.[0].critical.image."docker-manifest-digest"'
}

current_ref() { sed -n "s/^$1=//p" "$ENV_FILE"; }

set_refs() {
  sed -i -e "s|^RXF_SERVER_IMAGE=.*|RXF_SERVER_IMAGE=$1|" -e "s|^RXF_WEB_IMAGE=.*|RXF_WEB_IMAGE=$2|" "$ENV_FILE"
}

server_digest="$(verified_digest server)" || { log "signature check failed for server:$TAG"; exit 1; }
web_digest="$(verified_digest web)" || { log "signature check failed for web:$TAG"; exit 1; }
new_server="$REGISTRY/admin-v2-server@$server_digest"
new_web="$REGISTRY/admin-v2-web@$web_digest"
old_server="$(current_ref RXF_SERVER_IMAGE)"
old_web="$(current_ref RXF_WEB_IMAGE)"

[[ "$new_server" == "$old_server" && "$new_web" == "$old_web" ]] && exit 0
[[ -f "$FAILED_FILE" && "$(cat "$FAILED_FILE")" == "$new_server $new_web" ]] && exit 0
log "new images: $new_server $new_web"

docker pull --quiet "$new_server" >/dev/null
docker pull --quiet "$new_web" >/dev/null

if [[ ! -s "$KEY_FILE" ]]; then
  # First start: the key never leaves this host. Back it up separately (docs/OPERATIONS.md).
  # Written to a private temp file and moved into place, so a failed run leaves no empty key behind.
  mkdir -p "$(dirname "$KEY_FILE")"
  tmp_key="$(umask 077 && mktemp "$KEY_FILE.XXXXXX")"
  if ! docker run --rm --entrypoint node "$new_server" dist/cli.js keygen >"$tmp_key" || [[ ! -s "$tmp_key" ]]; then
    rm -f -- "$tmp_key"
    log "could not generate the master key"
    exit 1
  fi
  chown 10001:10001 "$tmp_key"
  chmod 0400 "$tmp_key"
  mv -- "$tmp_key" "$KEY_FILE"
  log "generated $PWD/$KEY_FILE - back it up now"
fi

# Consistent copy of the live database (WAL allows a reader next to the server); the server also keeps
# its own pre-migration backup when the new version brings migrations.
if docker compose ps --status running --quiet server | grep -q .; then
  docker compose exec -T -w /app server node -e "
    const Database = require('better-sqlite3');
    const db = new Database('/data/rxf-admin-v2.db');
    require('node:fs').mkdirSync('/data/backups', { recursive: true });
    db.prepare('VACUUM INTO ?').run('/data/backups/pre-deploy-' + Date.now() + '.db');
    db.close();
    const old = require('node:fs').readdirSync('/data/backups').filter((f) => f.startsWith('pre-deploy-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - $KEEP_PRE_DEPLOY))) require('node:fs').unlinkSync('/data/backups/' + f);
  "
  log "database backed up"
fi

set_refs "$new_server" "$new_web"
if docker compose up -d --wait --wait-timeout 120; then
  log "deployed $TAG"
  rm -f "$FAILED_FILE"
  docker image prune -f >/dev/null
  exit 0
fi

log "health checks failed, rolling back"
echo "$new_server $new_web" >"$FAILED_FILE"
if [[ -n "$old_server" && "$old_server" != *":$TAG" ]]; then
  set_refs "$old_server" "$old_web"
  docker compose up -d --wait --wait-timeout 120 || log "rollback did not become healthy either"
  log "rolled back to $old_server"
  log "if the new version migrated the database, restore its pre-migration backup (docs/OPERATIONS.md)"
fi
exit 1
