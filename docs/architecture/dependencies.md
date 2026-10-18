# Dependency-Tabelle v2 (Phase 2)

> Stand: 17.10.2026 · Versionen, Lizenzen und Veröffentlichungsdaten aus der
> npm-Registry (`npm view`). Browser-Größen selbst gemessen: esbuild,
> minifiziert, Tree-Shaking, gzip -9, React als extern (außer bei React
> selbst), mit den Importen, die wir tatsächlich nutzen würden. Server- und
> Dev-Pakete mit entpackter Installationsgröße.
>
> **Vom Owner freigegeben am 18.10.2026** (Auftrag §3). Jede weitere
> Abhängigkeit braucht eine neue Freigabe. Transitive
> Abhängigkeiten sind nicht einzeln aufgeführt; das Lockfile und osv-scanner
> decken sie ab.

## Budget-Rechnung für den Startbundle

Das Budget aus Auftrag §9 sind ≤ 150 KB gz für Login und Dashboard-Rahmen.

| Baustein | KB gz |
|---|---|
| `react` + `react-dom` | 67,3 |
| `@tanstack/react-router` | 27,8 |
| `@tanstack/react-query` | 10,2 |
| `zod/mini` (geteilte Schemas) | 4,6 |
| `sonner` (Toaster) | 9,5 |
| `@simplewebauthn/browser` | 2,8 |
| i18n-Laufzeit (eigene, Schätzung) | ~1 |
| App-Code Shell (Schätzung) | 15–20 |
| **Summe** | **≈ 138–143** |

Folgerung: Overlays (Dialog, Menü, Tooltip), Kommandopalette, Drag-and-drop,
Diagramme und Animationen dürfen **nicht** im Startpfad liegen. Sie kommen
als eigene Chunks und werden nach dem ersten Rendern im Leerlauf vorgeladen.
Mit `import { z } from 'zod'` statt `zod/mini` (90,8 KB) oder Base UI im
Startpfad (ab 23 KB für einen Dialog) wäre das Budget überschritten.

## Laufzeit: Server (`apps/server`, Plugins)

| Paket | Version | Zweck | Größe (installiert) | Lizenz | Wartung (letzte Veröffentlichung) | Alternative |
|---|---|---|---|---|---|---|
| `fastify` | 5.12.7 | HTTP-Server, Plugin-Kapselung, Schemas; enthält `pino` | 2,9 MB | MIT | aktiv (13.10.2026) | Hono |
| `@fastify/cookie` | 11.1.3 | Cookies lesen/setzen | 86 KB | MIT | aktiv (08.10.2026) | eigener Parser |
| `@fastify/rate-limit` | 11.2.1 | allgemeine API-Drossel (Login-Drossel ist eigene Logik, ADR 0005) | 222 KB | MIT | aktiv (08.10.2026) | eigene |
| `@fastify/swagger` | 9.9.2 | OpenAPI-Generierung, nur außerhalb Produktion ausgeliefert | 418 KB | MIT | aktiv (09.10.2026) | handgeschriebene Spec |
| `fastify-type-provider-zod` | 7.0.0 | Zod-Schemas als Fastify-Validierung und für OpenAPI | 150 KB | MIT | aktiv (24.06.2026) | `@fastify/type-provider-typebox` |
| `openapi-types` | 12.1.3 | Peer-Abhängigkeit des Type-Providers (nur Typen) | klein | MIT | stabil (24.05.2023) | – |
| `zod` | 4.6.7 | Schemas für API, Plugin-Konfiguration, Formulare; im Web als `zod/mini` | 6,0 MB (Web: 4,6 KB gz) | MIT | aktiv (12.10.2026) | Valibot |
| `better-sqlite3` | 13.0.3 | SQLite-Treiber (nativ, synchron, WAL) | 26,7 MB (inkl. SQLite-Quellcode) | MIT | aktiv (05.08.2026) | `node:sqlite` (sobald Drizzle 1.0 stabil) |
| `drizzle-orm` | 0.45.4 | typisierter Query-Builder und Schema | 10,3 MB | Apache-2.0 | aktiv (08.10.2026), 1.0 im RC | Kysely |
| `@node-rs/argon2` | 2.2.2 | Argon2id, vorkompilierte Binaries (kein `node-gyp`) | 44 KB + Binary | MIT | aktiv (06.10.2026) | `argon2` (node-gyp) |
| `otpauth` | 9.5.2 | TOTP (RFC 6238) | 974 KB | MIT | aktiv (03.09.2026) | eigene Umsetzung mit `node:crypto` |
| `@simplewebauthn/server` | 14.0.3 | Passkeys/WebAuthn prüfen | 761 KB (+ `@peculiar/*` ASN.1) | MIT | aktiv (25.09.2026) | – (Referenzbibliothek) |
| `undici` | 8.12.2 | HTTP-Client zu Geräten: Agent je Instanz, eigener Connector für TLS-Pinning, `MockAgent` für Vertragstests | 2,1 MB | MIT | aktiv (15.10.2026), Node-Projekt | `node:https` |
| `fast-xml-parser` | 5.11.2 | nur Plugin `fritzbox`: SOAP/TR-064, Host- und Anruflisten | 1,3 MB | MIT | aktiv (29.09.2026) | `txml` |

Bewusst **nicht** aufgenommen: `croner` (eigener Scheduler, ADR 0002),
`p-limit` (eigene Semaphore, wenige Zeilen), `prom-client` (deprecated,
`/metrics` selbst im Textformat), `tsx` (Node 26 führt TypeScript direkt
aus), `better-auth` (ADR 0005, Owner-Entscheidung).

## Laufzeit: Web (`apps/web`, Plugin-Web-Teile)

| Paket | Version | Zweck | Größe (gzip) | Lizenz | Wartung | Alternative |
|---|---|---|---|---|---|---|
| `react`, `react-dom` | 19.3.1 | UI | 67,3 KB | MIT | aktiv (15.10.2026) | Preact |
| `@tanstack/react-router` | 1.170.45 | typsichere Routen, Lazy-Routen | 27,8 KB | MIT | aktiv (16.10.2026) | wouter (≈ 2 KB, ohne Typsicherheit) |
| `@tanstack/react-query` | 5.104.3 | Server-State, Cache, Invalidierung durch SSE | 10,2 KB | MIT | aktiv (15.10.2026) | SWR |
| `@simplewebauthn/browser` | 14.0.0 | Passkeys im Browser | 2,8 KB | MIT | aktiv (02.09.2026) | `navigator.credentials` direkt |
| `sonner` | 2.0.8 | Toasts (Ergebnis von Aktionen) | 9,5 KB | MIT | aktiv (09.08.2026) | eigene Toasts |
| `cmdk` | 1.1.1 | Kommandopalette ⌘K, lazy | 17,5 KB | MIT | **ruhig** (letztes Release 27.08.2025) | eigene Combobox auf den UI-Primitives |
| `@number-flow/react` | 0.6.2 | animierte Kennzahlen (`tabular-nums`) | 6,0 KB | MIT | aktiv (18.07.2026), 0.x | `Intl.NumberFormat` ohne Animation |
| `@dnd-kit/core` + `@dnd-kit/sortable` | 6.3.1 / 10.0.0 | Widget-Raster: Drag-and-drop **und Tastatur**, nur im Bearbeitungsmodus geladen | 14,6 KB | MIT | **ruhig** (letztes Release 05.12.2024); Weiterentwicklung in `@dnd-kit/react` | `@dnd-kit/react` 0.5.1 (37,5 KB, 0.x) |
| `uplot` | 1.6.32 | Zeitreihen-Diagramme, eigener geteilter Chunk | 22,6 KB | MIT | stabil (14.03.2025), ein Maintainer | `recharts` 3.10.1 (107,8 KB gz – sprengt das Plugin-Budget) |

Kleine Diagramme (Sparklines, Balken, Donut, Meter) entstehen als eigenes
SVG ohne Bibliothek, nach dem `dataviz`-Skill (Phase 3).

## Entscheidungen des Owners (18.10.2026)

| Thema | Gewählt | Größe (gzip) | Lizenz | Wartung | Verworfen (Größe) |
|---|---|---|---|---|---|
| **UI-Primitives** | `@radix-ui/react-dialog`, `-dropdown-menu`, `-tooltip`, `-popover` (weitere Radix-Pakete wie `-select`, `-switch`, `-tabs` fallen unter diese Freigabe) | 9,2 KB (Dialog) · 32,8 KB (alle vier), nur in Lazy-Chunks | MIT | aktiv (14.10.2026) | `@base-ui/react` 1.9.0 (69,8 KB für dieselben vier) |
| **i18n** | eigene typisierte Kataloge (`@rxf/i18n`), Plural/Datum/Zahl über `Intl` | ≈ 1 KB | – | wir | Lingui 6.10 (3,2 KB + Babel-Makro), i18next + react-i18next (16,7 KB) |
| **Animation** | `motion` 14.3.0 mit `LazyMotion` + `domAnimation`, nur in Lazy-Chunks, `prefers-reduced-motion` immer beachtet | 30,4 KB (voll 46,0 KB) | MIT | aktiv (15.10.2026) | nur CSS/WAAPI |
| **Auth** | eigene Umsetzung (ADR 0005), Pakete siehe Server-Tabelle | – | – | – | `better-auth` 1.7.10 + `@better-auth/passkey` |

`motion` liegt nicht im Startpfad: Login und Dashboard-Rahmen nutzen
CSS-Übergänge; `motion` lädt mit dem ersten Chunk, der es braucht
(z. B. Bearbeitungsmodus, Onboarding).

## Entwicklung, Tests, Qualität (nicht ausgeliefert)

| Paket | Version | Zweck | Lizenz | Wartung |
|---|---|---|---|---|
| `typescript` | 7.0.2 | Typecheck (nativer Compiler) | Apache-2.0 | aktiv (17.10.2026) |
| `vite` | 8.3.4 | Web-Build, Dev-Server | MIT | aktiv (08.10.2026) |
| `@vitejs/plugin-react` | 6.1.2 | React-Unterstützung für Vite | MIT | aktiv (05.10.2026) |
| `drizzle-kit` | 0.31.11 | Migrationen erzeugen | MIT | aktiv (21.09.2026) |
| `@biomejs/biome` | 2.5.15 | Lint + Format | MIT OR Apache-2.0 | aktiv (30.09.2026) |
| `vitest` + `@vitest/coverage-v8` | 5.0.5 | Unit-/Integrationstests, Coverage | MIT | aktiv (15.10.2026) |
| `jsdom` | 30.1.3 | DOM für Komponententests | MIT | aktiv (15.10.2026) |
| `@testing-library/react` | 16.3.3 | Komponententests | MIT | aktiv (27.08.2026) |
| `msw` | 3.0.3 | API-Mocks im Web | MIT | aktiv (10.10.2026) |
| `@playwright/test` | 1.64.1 | E2E, Screenshots | Apache-2.0 | aktiv (17.10.2026) |
| `@axe-core/playwright` | 4.14.0 | Barrierefreiheit in E2E | **MPL-2.0** (schwaches Copyleft, nur Dev, nicht ausgeliefert) | aktiv (15.10.2026) |
| `knip` | 6.41.0 | unbenutzte Exporte/Abhängigkeiten | ISC | aktiv (09.10.2026) |
| `size-limit` + `@size-limit/file` | 14.2.0 | Bundle-Budget in CI | MIT | aktiv (07.10.2026) |
| `@types/node` | 26.6.5 | Typen | MIT | aktiv |
| `@types/react`, `@types/react-dom` | 19.3.0 | Typen | MIT | aktiv |
| `@types/better-sqlite3` | 9.6.0 | Typen | MIT | aktiv |

## Werkzeuge außerhalb von npm (CI und Betrieb)

| Werkzeug | Zweck | Lizenz |
|---|---|---|
| pnpm 12 (über Corepack) | Paketmanager | MIT |
| osv-scanner | Lückenscan des Lockfiles | Apache-2.0 |
| Trivy | Image-Scan | Apache-2.0 |
| cosign | Image-Signatur und -Prüfung (ADR 0009, Option B) | Apache-2.0 |
| Caddy 2 (Image) | Frontend ausliefern, `/api` proxyen, Sicherheits-Header | Apache-2.0 |
| Node 26 (Image) | Laufzeit `server` | MIT |

Alle GitHub Actions werden auf Commit-SHA gepinnt und über Dependabot
aktualisiert.
