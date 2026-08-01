# --- Build stage ---
# Node 22 = active LTS and part of the CI test matrix — build and CI run
# the same major version.
FROM node:25-alpine AS build
WORKDIR /app
# npm ci against the committed lockfile keeps builds reproducible; a bare
# `npm install` from package.json would float dependency versions per build.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# --- Serve stage (static via Caddy, proxies /api to backend) ---
FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
