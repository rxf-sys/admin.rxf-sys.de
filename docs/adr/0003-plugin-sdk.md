# ADR 0003 – Plugin-SDK: Vertrag, Laden, Lebenszyklus

- **Status:** Akzeptiert (18.10.2026)
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §6.1–6.2, `docs/integrations/README.md` (Abschnitt „Querschnitt“), ADR 0004, ADR 0008

## Kontext

Jede Integration ist ein Plugin. Die Analyse (Phase 1) zeigt Bausteine, die
viele Plugins brauchen: TLS-Pinning, Request-Allowlist, Rechte-Diagnose,
asynchrone Aktionen, Stream-Collectors, Session-Verwaltung, Options-Provider,
Single-Flight je Gerät. Ohne gemeinsames SDK würde jedes Plugin sie anders
(und unterschiedlich sicher) lösen.

Anforderungen aus dem Auftrag: Nur gewählte Plugins werden geladen (Server
und Web), Aktivieren ohne Neustart, Kern-Bundle ohne Plugin-Code, Nachweis
im CI.

## Optionen

| Option | Bewertung |
|---|---|
| **Plugins als Workspace-Pakete im Monorepo, zur Build-Zeit bekannt, zur Laufzeit per `import()` geladen** | Typsicherheit, ein Build, einfache Tests; neue Plugins brauchen ein Release |
| Plugins als zur Laufzeit nachinstallierbare Pakete (npm/Dateisystem) | flexibel, aber fremder Code im Prozess ohne Sandbox, Supply-Chain-Risiko, Versionierung schwierig |
| Plugins als eigene Prozesse/Container | starke Isolation, aber RAM-Budget (< 200 MB bei 5 Plugins) nicht haltbar |

## Entscheidung

**Plugins sind Workspace-Pakete (`packages/plugins/<id>`), erstanbieterisch
und reviewt.** Es gibt keinen Mechanismus, fremde Plugins zur Laufzeit
nachzuladen (Vertrauensmodell siehe ADR 0008).

### Paketaufbau

```text
packages/plugins/proxmox-ve/
├── manifest.json        # reine Daten, ohne Code
├── server/index.ts      # export default defineServerPlugin({...})
├── web/index.ts         # export default defineWebPlugin({...})
├── web/widgets/*.tsx    # je Widget ein eigenes Modul (eigener Chunk)
├── web/pages/*.tsx      # je Seite ein eigenes Modul
├── i18n/{de,en}.ts      # Kataloge des Plugins
├── fixtures/            # aufgezeichnete, anonymisierte Antworten
└── README.md            # Nutzerdoku, Token-Anleitung (Quelle: docs/integrations/<id>.md)
```

`package.json` exportiert `./manifest.json`, `./server` und `./web` getrennt.
Der Server importiert nie `./web`, der Web-Build nie `./server`.

### Manifest (Daten, kein Code)

```jsonc
{
  "id": "proxmox-ve",            // [a-z0-9-], eindeutig, Präfix für Tabellen und Metriken
  "name": { "de": "Proxmox VE", "en": "Proxmox VE" },
  "version": "1.0.0",
  "core": "^1.0.0",              // kompatible Kern-Version (SemVer-Range)
  "category": "virtualization",  // virtualization|network|router|backup|dns-edge|container|smart-home|monitoring|channel
  "icon": "icon.svg",
  "description": { "de": "…", "en": "…" },
  "multiInstance": true,         // mehrere Exemplare (z. B. je Docker-Host)
  "docs": "https://pve.proxmox.com/pve-docs/chapter-pveum.html"
}
```

Der Server liest alle Manifeste als JSON (billig) und liefert den Katalog
über `GET /api/plugins/catalog`. Das Web zeigt Katalog und Icons, **ohne**
Plugin-Code zu laden.

### Server-Vertrag (`defineServerPlugin`)

| Teil | Inhalt |
|---|---|
| `configSchema` | `zod/mini`-Schema mit Metadaten je Feld: Label, Hilfetext, Doku-Link, `secret: true`, `options: <providerId>` (Auswahl live vom Gerät), `adminOnly` (z. B. Ziel-URL). Erzeugt Formular, Validierung und Typen. |
| `credentials` | Benannte Secret-Slots, z. B. `read` und optional `action` (Cloudflare, Tailscale). Aktionen nutzen den `action`-Slot, wenn gesetzt. |
| `targets(config)` | Liste erlaubter Ziele (`scheme://host:port`). Der SDK-HTTP-Client verweigert alles andere (SSRF, ADR 0008). |
| `requests` | Allowlist erlaubter Anfragen: Methode + Pfadmuster, getrennt nach `collect` (nur lesend) und `action`. Der Client prüft jede Anfrage dagegen. |
| `test(ctx)` | Verbindungstest. Liefert `{ ok, capabilities: [{ id, status: ok\|missing\|excessive\|unsupported, code, message }], tls?: { fingerprint, … } }`. Teil-Erfolg ist möglich; `excessive` meldet zu weite Rechte (Docker). |
| `collectors` | Liste von Collectors (s. u.). |
| `actions` | Liste von Aktionen (s. u.). |
| `options` | Options-Provider für Formularfelder (Datastores, Zonen, Entitäten). |
| `alerts` | Vorgeschlagene Alarmregeln (Vorlagen, ADR 0004). |
| `migrations` | SQL-Migrationen für plugin-eigene Tabellen mit Präfix `p_<id>_` (Bindestriche → `_`). |

Ein Plugin bekommt keinen direkten Datenbankzugriff, sondern einen
`ctx` mit: `http` (gepinnter, allowlist-geprüfter Client; Pfade nur über
einen Template-Helfer, der jeden Parameter URL-encodiert – Lehre #17), `store`
(Entitäten/Metriken schreiben), `pluginDb` (nur eigene Tabellen), `log`
(mit Redaction), `kv` (kleiner Zustand, z. B. Session-IDs, verschlüsselt
wenn `secret`), `signal` (Abbruch bei Pause/Entfernen), `now()`.

#### Collectors

```ts
{
  id: 'cluster-resources',
  interval: { active: '10s', background: '60s' },   // aktiv = jemand sieht zu (ADR 0007)
  timeout: '5s',
  kind: 'poll',                                       // oder 'stream' (Docker /events, HA WebSocket)
  singleFlight: true,                                 // nie parallel mit sich selbst
  run: async (ctx) => { /* … */ return { entities, metrics } },
}
```

Der Kern übernimmt: Scheduling mit Jitter (± 10 %), Timeout, exponentiellen
Backoff, **Circuit Breaker je Instanz** (nach 3 Fehlern offen, halb offen nach
Backoff), Deduplizierung gleicher Läufe, **Single-Flight-Queue je Instanz**
für schwache Geräte (`maxConcurrent: 1`, FRITZ!Box), globale
Parallelitätsgrenze. Ein ausgefallenes Gerät blockiert keine andere Instanz.

Ein Lauf liefert einen **vollständigen Schnappschuss** seiner Entitäten. Was
fehlt, wird nach Ablauf einer Karenz als `unknown` markiert, nicht sofort
gelöscht. Stream-Collectors liefern Teil-Updates und haben einen
periodischen Voll-Abgleich.

#### Aktionen

```ts
{
  id: 'guest.reboot',
  label: { de: 'Neu starten', en: 'Reboot' },
  risk: 'medium',                 // low | medium | high
  role: 'operator',               // Mindestrolle; high erzwingt admin, falls nicht anders begründet
  cutsAccess: false,              // true: kann den Dashboard-Zugang kappen (Gateway, Reconnect)
  target: 'Guest',                // Entitätstyp, auf den die Aktion zielt
  params: z.object({ timeout: z.optional(z.int().check(z.minimum(0), z.maximum(600))) }),
  audit: (p, e) => ({ de: `${e.name} neu gestartet`, en: `Rebooted ${e.name}` }),
  run: async (ctx, target, params) => ({ jobId }),   // asynchron, Fortschritt über ctx.progress()
}
```

Regeln des Kerns: Aktionen sind je Instanz **standardmäßig aus** (ADR 0001
§5) und einzeln freizuschalten. `risk: high` verlangt Re-Authentifizierung
(ADR 0005) und eine getippte Bestätigung. Jede Ausführung landet mit
Ergebnis im Audit-Log. Lange Aktionen laufen als Job mit Fortschritt
(SSE, ADR 0007) und Timeout bis 5 min.

### Web-Vertrag (`defineWebPlugin`)

```ts
export default defineWebPlugin({
  id: 'proxmox-ve',
  widgets: {
    'node-load': {
      title: { de: 'Knotenauslastung', en: 'Node load' },
      sizes: ['S', 'M', 'L'],
      settings: z.object({ nodeId: z.optional(z.string()) }),
      component: () => import('./widgets/node-load'),
    },
  },
  pages: [
    { path: 'guests', title: { de: 'Gäste', en: 'Guests' }, component: () => import('./pages/guests') },
    { path: 'guests/$externalId', component: () => import('./pages/guest-detail') },
  ],
  i18n: { de: () => import('../i18n/de'), en: () => import('../i18n/en') },
  commands: [/* Einträge für die Kommandopalette, ohne Code-Import */],
});
```

- Widgets lesen **nur über die Kern-API** (Entitäten, Metriken, Aktionen),
  nie direkt vom Gerät. Gleiche Abfragen teilen sich den TanStack-Query-Cache.
- Plugin-Seiten hängen unter der Kern-Route `/p/$instanceId/$` (Splat). Der
  Kern ordnet den Rest des Pfads der Seitenliste des Plugins zu; Parameter
  werden mit Zod geprüft. Deep-Links funktionieren, ohne dass der
  Routenbaum des Kerns Plugin-Code enthält.

### Laden nur, was gewählt ist

**Server:** Ein generiertes Register (`apps/server/src/plugins.generated.ts`)
enthält je Plugin nur `id` und `() => import('@rxf/plugin-<id>/server')`.
Der Kern importiert ein Plugin erst, wenn eine Instanz aktiv wird – beim
Start oder zur Laufzeit beim Aktivieren. Pausieren/Entfernen bricht
laufende Collectors über `signal` ab und stoppt den Scheduler für die
Instanz. **Grenze:** Ein einmal geladenes ES-Modul bleibt bis zum Neustart
im Speicher; entfernte Plugins belegen also bis dahin wenige MB. Nicht
gewählte Plugins werden nie geladen.

**Web:** Ein generiertes Register (`apps/web/src/plugins.generated.ts`) mit
`id → () => import('@rxf/plugin-<id>/web')`. Vite erzeugt daraus je Plugin
eigene Chunks (`plugin-<id>-[hash].js`, je Widget/Seite weitere). Die Shell
fragt beim Start `GET /api/plugins/active` ab und lädt das Plugin-Modul erst,
wenn ein Widget oder eine Seite dieses Plugins in den Viewport kommt.

**Nachweis im CI** (Phase 4):
1. Statisch: Das Vite-Manifest wird geprüft; kein Modul unter
   `packages/plugins/` darf im Entry-Chunk oder in dessen statischen Imports
   liegen.
2. Laufzeit: Ein Playwright-Test startet die App mit nur `uptime` aktiv,
   zeichnet alle Requests auf und schlägt fehl, wenn ein Chunk eines anderen
   Plugins geladen wird.
3. `size-limit`: Entry ≤ 150 KB gz, jeder `plugin-*`-Chunk ≤ 60 KB gz.

### Lebenszyklus einer Instanz

```text
entwurf ──test ok──▶ aktiv ◀──▶ pausiert
   │                   │            │
   └──────────── entfernen (mit Bestätigung, Export-Hinweis) ──▶ gelöscht
```

- **Entwurf:** Zwischenstand des Assistenten, Secrets bereits verschlüsselt,
  keine Collectors.
- **Pausiert:** Konfiguration bleibt, Collectors stoppen, Entitäten bekommen
  Status `paused`, Widgets zeigen „pausiert“.
- **Entfernen:** löscht Konfiguration, Secrets, Entitäten, Metriken,
  plugin-eigene Tabellenzeilen der Instanz und Widgets auf allen Boards.

### Pi-hole und AdGuard Home

Zwei Plugins (`pihole`, `adguard-home`) plus ein gemeinsames Paket
`@rxf/kit-dns-filter` (Datenmodell, Widgets, Alarmvorlagen, Aktion „Schutz
pausieren“). Begründung in `docs/integrations/pihole-adguard.md`.

## Folgen

- `docs/PLUGINS.md` (Phase 4) beschreibt den Vertrag mit einer
  Beispiel-Vorlage; Ziel: neues Plugin in unter einer Stunde.
- Die Register-Dateien werden aus `packages/plugins/*/manifest.json`
  generiert und nicht von Hand gepflegt.
- Plugins sind nicht isoliert: Ein fehlerhaftes Plugin kann den Prozess
  belasten. Gegenmittel sind Review, Timeouts, Abbruchsignale und die
  Parallelitätsgrenze, keine Sandbox.
- Kanäle (ntfy, E-Mail, Webhook) nutzen denselben Vertrag mit Kategorie
  `channel` und einer zusätzlichen Fähigkeit `send(alert)` (Phase 7).
