# syntax=docker/dockerfile:1
# Web image (ADR 0009): Caddy serves the built app and proxies /api; non-root, read-only root file system.

# The build base can be swapped for a local one (e.g. behind a proxy); the runtime base is always the pinned one.
ARG BUILD_IMAGE=node:26.12.0-trixie-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11

FROM ${BUILD_IMAGE} AS build
WORKDIR /repo
COPY package.json ./
RUN npm install --global --ignore-scripts "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @rxf/web build

FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
  XDG_DATA_HOME=/tmp/caddy-data
COPY infrastructure-v2/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
RUN rm -f /srv/.vite/manifest.json && rmdir /srv/.vite
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
