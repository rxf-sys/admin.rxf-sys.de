# syntax=docker/dockerfile:1
# Server image (ADR 0009): built from the repository root, runs as UID 10001 on a read-only root file system.

# The build base can be swapped for a local one (e.g. behind a proxy); the runtime base is always the pinned one.
ARG BUILD_IMAGE=node:26.12.0-trixie-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11

FROM ${BUILD_IMAGE} AS build
# No compiler needed: better-sqlite3 ships prebuilt N-API binaries for linux-x64 and linux-arm64.
WORKDIR /repo
COPY package.json ./
RUN npm install --global --ignore-scripts "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b
# A self-contained copy of the server with production dependencies only; workspace packages arrive with dist/.
RUN pnpm --filter @rxf/server deploy --prod --legacy /out

FROM node:26.12.0-trixie-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11
# Debian security fixes newer than the pinned base (the image job fails on fixable HIGH/CRITICAL findings).
# OS_UPGRADE=0 only for local builds without access to the Debian mirrors.
ARG OS_UPGRADE=1
RUN if [ "$OS_UPGRADE" = 1 ]; then \
    apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*; \
  fi
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  RXF_DATA_DIR=/data \
  RXF_MASTER_KEY_FILE=/run/secrets/rxf_master_key
ARG RXF_VERSION=dev
ENV RXF_VERSION=${RXF_VERSION}
WORKDIR /app
COPY --from=build --chown=0:0 /out /app
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
