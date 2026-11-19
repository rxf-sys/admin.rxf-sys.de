# Plugins entwickeln

Leitfaden für neue Integrationen in v2. Die Entscheidungen dahinter stehen in ADR 0003 (SDK), 0004
(Datenmodell), 0007 (Live-Updates) und 0008 (Sicherheit). Das Referenz-Plugin ist
`packages/plugins/uptime`.

Plugins laufen im selben Prozess wie der Kern, ohne Sandbox. Deshalb gibt es nur Plugins aus diesem
Repository, jedes mit Review und `security-review` vor dem Merge (ADR 0008, Vertrauensmodell).

## Aufbau eines Plugin-Pakets

```text
packages/plugins/<id>/
├── manifest.json        # reine Daten: Name, Beschreibung, Kategorie, Version
├── package.json         # Name @rxf/plugin-<id>, Exporte ./manifest.json, ./server, ./web
├── tsconfig.json        # Server- und shared-Teil für tsc -b
├── server/index.ts      # export default defineServerPlugin({...})
├── shared/              # optional: Logik für Server und Web (z. B. Statusregeln)
└── web/
    ├── index.ts         # export default defineWebPlugin({...})
    ├── widgets/*.tsx    # je Widget ein Modul, wird ein eigener Chunk
    └── config-form.tsx  # optional: Formular für den Onboarding-Assistenten
```

Die Regeln dazu:

- Der Ordnername ist die Plugin-ID: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 40 Zeichen.
  Er muss mit `manifest.id` übereinstimmen.
- Der Paketname ist `@rxf/plugin-<id>`.
- Der Server importiert nie `./web`, das Web nie `./server`. Gemeinsames gehört nach `shared/`.
- `apps/server/package.json` muss das Plugin als Abhängigkeit führen, `apps/web/package.json` ebenfalls,
  sobald es einen Web-Teil gibt.

Danach `pnpm generate:plugins` ausführen. Das erzeugt die Registries
`apps/server/src/plugins.generated.ts` und `apps/web/src/plugins.generated.ts`. `pnpm lint` schlägt
fehl, wenn sie nicht aktuell sind.

## Manifest

```json
{
  "id": "example",
  "name": { "de": "Beispiel", "en": "Example" },
  "description": { "de": "Kurz, was es zeigt.", "en": "What it shows, briefly." },
  "version": "0.1.0",
  "core": "^2.0.0",
  "icon": "activity",
  "category": "monitoring",
  "multiInstance": false,
  "docs": "docs/integrations/example.md"
}
```

Mögliche Kategorien: `virtualization`, `network`, `router`, `backup`, `dns-edge`, `container`,
`smart-home`, `monitoring`, `channel`. Der Katalog im Onboarding liest nur das Manifest. Plugin-Code
lädt erst, wenn eine Instanz ihn braucht.

## Server-Teil

```ts
import { defineConfig, defineServerPlugin, field, originOf } from '@rxf/sdk';
import * as z from 'zod/mini';

const config = defineConfig({
  url: field(z.string(), { label: { de: 'Adresse', en: 'Address' }, adminOnly: true }),
  token: field(z.string(), { label: { de: 'API-Token', en: 'API token' }, secret: true }),
});

export default defineServerPlugin({
  config,
  targets: (cfg) => [{ origin: originOf(cfg.url), tls: { mode: 'system' } }],
  requests: { collect: [{ method: 'GET', path: '/api/v1/**' }] },
  async test(ctx) {
    /* eine echte, lesende Anfrage; Ergebnis je Fähigkeit */
    return { ok: true, capabilities: [{ id: 'read', status: 'ok' }] };
  },
  collectors: [
    {
      id: 'status',
      interval: { activeMs: 15_000, backgroundMs: 60_000 },
      timeoutMs: 10_000,
      async run(ctx) {
        return { entities: [], metrics: [] };
      },
    },
  ],
});
```

### Konfiguration

- Felder beschreibt `field(schema, { label, help?, secret?, adminOnly? })`. Schemas kommen aus `zod/mini`.
- `secret: true`:
  - Der Kern verschlüsselt den Wert je Instanz und Feld (AES-256-GCM, ADR 0006).
  - Die API zeigt nur „gesetzt / zuletzt geändert“.
  - Das Plugin bekommt den Wert nur über `ctx.secrets`.
  - Secret-Felder sind Strings auf oberster Ebene.
  - Ein leerer Wert beim Speichern lässt das gespeicherte Secret unverändert.
- `adminOnly: true` gilt für alles, was Ziele bestimmt (Host, URL, Port) oder gesperrte Adressen
  freigibt. Ändern dürfen solche Felder nur Admins, und nur mit Re-Auth.

### Ziele und Anfragen (SSRF-Schutz, ADR 0008)

- `targets(config)` liefert jeden Gegenüber als `scheme://host:port` mit TLS-Modus:
  - `system`: öffentliche CA
  - `pin-leaf` / `pin-spki`: SHA-256 als `pinSha256`
  - `ca`: eigene CA als PEM

  Der HTTP-Client verweigert jedes andere Ziel, bevor er eine Verbindung aufbaut.
- `requests.collect` ist die Allowlist aus Methode und Pfadmuster. `*` steht für genau ein Segment, `**`
  für den Rest. Pfade mit `%2F`/`%5C` lehnt der Client ab.
- Loopback, Link-Local und die eigene Container-Adresse sind gesperrt. Freigeben lassen sie sich nur über
  `allowBlockedAddresses(config)`, gesteuert durch ein `adminOnly`-Feld.
- Redirects folgt der Client nicht, Antworten begrenzt er auf eine Größe.
- Jede Anfrage bekommt `{ signal: ctx.signal, timeoutMs }`, damit Pausieren und Zeitlimits greifen.
- Für Prüfungen ohne HTTP gibt es `ctx.net`, unter denselben Regeln:

  | Methode | Ziel in `targets()` | Fehlercodes (Auswahl) |
  |---|---|---|
  | `tcp(origin)` | `tcp://host:port` | `CONNECTION_REFUSED`, `CONNECT_TIMEOUT`, `NET_UNREACHABLE` |
  | `tls(origin, { servername })` | `tls://host:port`, TLS-Modus wie bei HTTP | `TLS_EXPIRED`, `TLS_SELF_SIGNED`, `TLS_HOSTNAME`, `TLS_PIN_MISMATCH` |
  | `dns({ name, type, server })` | `dns://ip:port`; ohne `server` der System-Resolver | `DNS_NOT_FOUND`, `DNS_TIMEOUT` |
  | `ping(origin, { count })` | `icmp://host` | `ICMP_NO_REPLY`, `ICMP_UNAVAILABLE` |

  `ping` pingt die geprüfte, aufgelöste Adresse, nie den Namen (DNS-Rebinding). `ctx.http.inspectTls`
  liest auch Zertifikate von `tls://`-Zielen.

### `test()`

- Läuft beim Einrichten und vor dem Aktivieren.
- `ok: false` nur bei Fehlern in der Konfiguration, zum Beispiel falsches Token, gesperrtes Ziel oder
  TLS. Ein Gerät, das gerade nicht erreichbar ist, ist kein Konfigurationsfehler.
- Je Fähigkeit ein Eintrag mit `status` (`ok`, `missing`, `excessive`, `unsupported`, `failed`), einem
  stabilen `code` und einer kurzen `message`.
- Bei einem nicht vertrauenswürdigen Zertifikat `ctx.http.inspectTls(url)` zurückgeben. Das Onboarding
  zeigt dann Fingerabdruck und Aussteller zur Bestätigung an.

### Collectors

- **Ein Lauf liefert einen vollständigen Schnappschuss:**
  - `entities` mit `kind`, `externalId`, `name`, `status` (`ok`, `warn`, `crit` oder `unknown`; `paused`
    setzt der Kern), `statusReason` als Code (`[A-Z0-9_]`) und `attrs` (höchstens 16 KB)
  - `metrics` mit Entität, Name (`plugin.wert`), Einheit und Wert

  Entitäten, die fehlen, werden nach zwei Hintergrundintervallen `unknown`. Mit `onMissing: 'delete'`
  löscht der Kern sie sofort samt Messreihen. Das passt nur, wenn der Schnappschuss allein aus der
  Konfiguration folgt (Uptime-Checks): Dort heißt „fehlt“, dass der Admin den Eintrag entfernt hat.
- **`collectors`** ist eine feste Liste oder eine Funktion der Konfiguration, zum Beispiel ein Collector je
  Intervall. Die IDs müssen stabil sein: Verschwindet ein Collector, löscht der Kern beim nächsten Start
  der Instanz alle Entitäten, die ihm gehörten.
- **Was der Kern übernimmt** (ADR 0003):
  - Jitter, Zeitlimit und Backoff
  - Circuit Breaker je Instanz
  - Parallelität: keine überlappenden Läufe; `maxConcurrent` am Plugin für schwache Geräte
  - Wechsel zwischen aktivem und Hintergrund-Intervall, je nachdem, ob jemand zuschaut
- **Ungültige Schnappschüsse** schreibt der Kern nicht. Er zählt sie als Fehler.
- **Fehler von Geräten** gehören als Status in die Entität (`crit` + Code). Werfen sollte ein Collector nur,
  wenn er gar nichts liefern kann.
- **Ins Log** gehören keine Antworten von Geräten und keine Secrets. Der Kern protokolliert bei Fehlern nur
  Code und Fehlerklasse.

## Web-Teil

```ts
import { defineWebPlugin } from '@rxf/web-sdk';

export default defineWebPlugin({
  id: 'example',
  widgets: {
    status: {
      title: { de: 'Status', en: 'Status' },
      sizes: ['M', 'L'],
      component: () => import('./widgets/status.tsx'),
    },
  },
  onboarding: { configForm: () => import('./config-form.tsx') },
});
```

- **Daten:** Widgets lesen nur über die Kern-API (`props.data.entities`, `series`, `points`), nie direkt
  vom Gerät. Für den Cache gelten die `queryKeys` aus `@rxf/contracts`; dann invalidieren die
  Live-Updates automatisch.
- **Darstellung:**
  - Status immer als Text und Farbe, nie nur als Farbe.
  - Kleine Diagramme als eigenes SVG nach dem dataviz-Skill.
  - Farben und Abstände nur aus den Tokens (`packages/ui`).
- **Grenzen:**
  - Kein `dangerouslySetInnerHTML` und keine Inline-Styles, weil die CSP sie verbietet.
  - Jeder `plugin-*`-Chunk ist höchstens 60 KB gzip groß.
  - Plugin-Code darf nie im Einstiegs-Chunk landen. `tooling/check-web-bundle.ts` prüft beides im CI.
- **Onboarding:** `configForm` bekommt `value` (gespeicherte Konfiguration eines Entwurfs) und meldet
  über `onChange(config, valid)`. Das Speichern übernimmt der Kern, mit Re-Auth.
  `trustCertificate(config, cert)` setzt nach dem Bestätigen den Pin.
- **Texte:** auf Deutsch zuerst, mit englischer Übersetzung, über `createTranslator` aus `@rxf/i18n`.

## Tests und Gates

- Server-Tests neben dem Code (`server/*.test.ts`). Gegen das Gerät mit aufgezeichneten, anonymisierten
  Antworten, ohne echte Geräte im CI.
- Web-Tests mit `// @vitest-environment jsdom` (`web/*.test.tsx`).
- Coverage je Plugin mindestens 70 %.
- Vor dem PR alle Gates:
  `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm size && pnpm knip`,
  dazu `pnpm e2e`.
- Eine Integrationsnotiz unter `docs/integrations/<id>.md` beschreibt:
  - Rechte, getrennt nach nur lesend und Aktionen
  - die Token-Anleitung
  - die Fehlercodes

## Checkliste für den PR

- [ ] Manifest, Paketname und Registries stimmen; `pnpm lint` ist grün.
- [ ] Ziele und Request-Allowlist sind so eng wie möglich, Ziel-Felder sind `adminOnly`.
- [ ] Secrets sind nur `secret: true`-Felder und tauchen in Log, `attrs` und Fehlermeldungen nicht auf.
- [ ] `test()` unterscheidet Konfigurationsfehler von einem Gerät, das nicht erreichbar ist.
- [ ] Collector-Schnappschüsse sind vollständig, Status mit Code.
- [ ] Widgets lesen nur über die Kern-API; kein Plugin-Code im Einstiegs-Chunk; Chunk unter 60 KB.
- [ ] Tests mit mindestens 70 % Coverage, Integrationsnotiz aktuell.
- [ ] `security-review` gelaufen, Befunde behoben oder vom Owner entschieden.
