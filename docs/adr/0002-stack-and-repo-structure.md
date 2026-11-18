# ADR 0002 – Tech-Stack und Repo-Struktur

- **Status:** Akzeptiert (18.10.2026)
- **Datum:** 17.10.2026
- **Bezug:** ADR 0001 §2 (TypeScript-Monorepo), Auftrag §7 und §9, `docs/architecture/dependencies.md`

## Kontext

ADR 0001 legt TypeScript für Kern und Plugins fest. Offen sind die konkreten
Versionen, die Werkzeuge und der Aufbau des Monorepos. Zwei Randbedingungen
prägen die Wahl:

1. **Bundle-Budget** (Auftrag §9): initial ≤ 150 KB JS gzip, pro Plugin-Chunk
   ≤ 60 KB. Gemessen am 17.10.2026 (esbuild, minifiziert, gzip -9, React
   extern außer bei React selbst):

   | Baustein | gzip |
   |---|---|
   | `react` + `react-dom` | 67,3 KB |
   | `@tanstack/react-router` | 27,8 KB |
   | `@tanstack/react-query` | 10,2 KB |
   | `zod` (Namespace-Import, 1 Objekt-Schema) | 24,4 KB |
   | `zod` (`import { z }`, gleiches Schema) | 90,8 KB |
   | `zod/mini` | 4,6 KB |

   Allein React, Router und Query belegen 105 KB. Jede weitere Bibliothek im
   Startpfad muss sich rechtfertigen.

2. **Laufzeit:** Node 22 ist seit 21.10.2025 nur noch in Maintenance und endet
   am 30.04.2027, also etwa zur geplanten Fertigstellung. Node 24 endet am
   30.04.2028, Node 26 wird am 28.10.2026 LTS und läuft bis 30.04.2029
   ([nodejs/Release `schedule.json`](https://github.com/nodejs/Release/blob/main/schedule.json)).

## Optionen

### Laufzeit

| Option | Bewertung |
|---|---|
| Node 22 (Auftrag) | EOL 30.04.2027, kurz nach Projektende → sofortiges Upgrade nötig |
| Node 24 | Active LTS bis 20.10.2026, dann Maintenance bis 30.04.2028 |
| **Node 26** | ab 28.10.2026 LTS bis 30.04.2029; native Type-Stripping, `node:sqlite` |

### Styling

| Option | Bewertung |
|---|---|
| **CSS Custom Properties + CSS Modules** | keine Laufzeit- und keine Build-Dependency (Vite kann CSS Modules), deckt sich mit Signal (reines CSS mit `:root`-Tokens, siehe `rxf-sys/www.rxf-sys.de/index.css`) und dem Alt-Frontend (`frontend/src/styles/tokens.css`) |
| Tailwind v4 | gute DX, aber zweites Token-System neben Signal, zusätzliche Build-Plugin-Abhängigkeit |

### Linting/Format

| Option | Bewertung |
|---|---|
| **Biome 2** | ein Werkzeug für Lint + Format, schnell, keine Abhängigkeit von der TypeScript-JS-API (wichtig für TS 7) |
| ESLint + Prettier + typescript-eslint | mehr Regeln, aber typescript-eslint hängt an der TS-JS-API |

## Entscheidung

| Bereich | Wahl | Begründung |
|---|---|---|
| Paketmanager | **pnpm 12** Workspaces, Version über `packageManager` in `package.json` gepinnt | Auftrag §7; strikte Abhängigkeitsauflösung |
| Laufzeit | **Node 26 LTS**, CI zusätzlich Node 24 | längster Support; Abweichung vom Auftrag (Node 22) wegen EOL 04/2027 |
| Sprache | **TypeScript 7** (`strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`) | nativer Compiler, Node führt TS-Dateien in Dev direkt aus (kein `tsx`) |
| Server | **Fastify 5** + `fastify-type-provider-zod` 7 + `@fastify/swagger` (OpenAPI nur außerhalb Produktion, Lehre #4) | Auftrag §7 |
| Validierung | **Zod 4**; geteilte API- und Plugin-Schemas in **`zod/mini`** | 4,6 KB statt ≥ 24 KB im Browser; Server und Web nutzen dieselben Schemas |
| API-Konventionen | JSON, Fehler immer `{ "error": { "code": "STRING_CODE", "message": "…", "details"?: {…} } }`, Antworten im Web per Schema geprüft | Lehren #18 und #21 |
| Datenbank | **SQLite (WAL)** über **`better-sqlite3`** + **Drizzle ORM 0.45** + `drizzle-kit` | Drizzle unterstützt `node:sqlite` erst in 1.0-RC; Wechsel auf Drizzle 1.0 (und ggf. `node:sqlite`) per eigenem PR, sobald 1.0 stabil ist |
| HTTP zu Geräten | **`undici`** (npm-Version gepinnt) | eigene Agents pro Instanz, Connector für TLS-Pinning (ADR 0008) |
| Hintergrundjobs | **eigener Scheduler** im Kern, keine Cron-Bibliothek | Collectors brauchen Jitter, Backoff, Circuit Breaker und Schnell/Langsam-Takt; Cron-Ausdrücke werden nicht gebraucht (Abweichung vom Vorschlag `croner`) |
| Logs | **pino** (in Fastify enthalten), Redaction für Secrets | Auftrag §7 |
| Metriken | eigener `/metrics`-Endpunkt im Prometheus-Textformat, optional | `prom-client` ist deprecated, Nachfolger noch 0.x |
| Frontend | **React 19**, **Vite 8**, **TanStack Router** (Code-basierte Routen) + **TanStack Query** | Auftrag §7 |
| Styling | **CSS Custom Properties + CSS Modules** | siehe Optionen |
| UI-Primitives | **Radix** (`@radix-ui/react-*`), nur in Lazy-Chunks | 32,8 KB gz für Dialog, Menü, Tooltip, Popover gegenüber 69,8 KB bei Base UI (Owner-Entscheidung 18.10.2026) |
| i18n | **eigene typisierte Kataloge** (`@rxf/i18n`) | ≈ 1 KB, fehlende Übersetzung = Compile-Fehler (Owner-Entscheidung 18.10.2026) |
| Diagramme | **uPlot** (geteilter Lazy-Chunk) + eigene SVG-Kleindiagramme | recharts (107,8 KB gz) sprengt das Plugin-Budget |
| Animation | **motion** (`LazyMotion` + `domAnimation`, nur in Lazy-Chunks), sonst CSS; `prefers-reduced-motion` immer beachtet | Owner-Entscheidung 18.10.2026; 30,4 KB gz, deshalb nicht im Startpfad |
| Lint/Format | **Biome 2** | siehe Optionen; TS-Typecheck über `tsc --noEmit` |
| Tests | **Vitest**, Testing Library, **MSW** (Web), **undici `MockAgent`** (Plugin-Vertragstests), **Playwright** + `@axe-core/playwright` | Auftrag §7 und §11 |
| Qualität | `knip`, `size-limit`, `osv-scanner` und Trivy (Binaries in CI), Dependabot | Auftrag §7; Renovate entfällt, Dependabot ist eingerichtet |

### Repo-Struktur

Der Neubau entsteht auf `v2` **neben** dem Altcode. `backend/`, `frontend/`
und `infrastructure/` bleiben bis zum Umstieg (Phase 9) unverändert, damit
Fixes von `main` konfliktfrei nach `v2` gemergt werden können.

```text
├── apps/
│   ├── server/                 # Fastify-Kern: Auth, Registry, Scheduler, Storage, SSE, API
│   └── web/                    # React-Shell: Login, Onboarding, Dashboard, Einstellungen
├── packages/
│   ├── sdk/                    # Plugin-Vertrag (Typen, define*-Helfer), HTTP-Client mit Pinning/Allowlist, Testhilfen
│   ├── contracts/              # API-Schemas (zod/mini) für Server und Web
│   ├── ui/                     # Design-Tokens (Signal) und Primitives (CSS Modules)
│   ├── i18n/                   # Übersetzungs-Laufzeit + Kern-Kataloge DE/EN
│   ├── plugins/<id>/           # je Plugin: manifest.json, server/, web/, fixtures/, README.md
│   └── kits/<name>/            # geteilte Plugin-Bausteine, z. B. dns-filter
├── tooling/                    # tsconfig-Basis, size-limit, Bundle-Prüfung, Skripte
├── e2e/                        # Playwright
├── docs/                       # ADRs, Architektur, Plugins, Betrieb
├── backend/ frontend/ infrastructure/   # Altcode bis Phase 9
├── pnpm-workspace.yaml         # nur apps/*, packages/**, tooling, e2e (nicht frontend/)
└── biome.json
```

Paketnamen: `@rxf/server`, `@rxf/web`, `@rxf/sdk`, `@rxf/contracts`,
`@rxf/ui`, `@rxf/i18n`, `@rxf/plugin-<id>`, `@rxf/kit-<name>`.

## Folgen

- **Abweichungen vom Auftrag**, vom Owner am 18.10.2026 freigegeben: Node 26
  statt 22, TypeScript 7, eigener Scheduler statt `croner`, kein
  `prom-client`, `zod/mini` für geteilte Schemas, Biome statt
  ESLint+Prettier, Radix statt Base UI, eigene i18n statt
  react-i18next/Lingui, uPlot statt recharts.
- `zod` muss im Web immer als Namespace importiert werden (`import * as z`);
  eine Biome-Regel (`noRestrictedImports`) verbietet `import { z } from 'zod'`.
- TypeScript 7 ist neu. Fällt ein Werkzeug aus (z. B. `knip`), weichen wir
  auf TS 6 aus; das ist eine reine Dev-Abhängigkeit.
- `better-sqlite3` ist ein natives Modul: Docker-Build braucht Prebuilds für
  `linux-x64` (glibc oder musl) oder Build-Werkzeuge im Build-Stage.
- Drizzle 1.0 bringt Breaking Changes in den Relational Queries. Der Kern nutzt
  deshalb vorerst nur den Query-Builder, nicht `db.query.*`.
