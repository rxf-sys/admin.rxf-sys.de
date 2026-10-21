# Design-System v2

- **Stand:** 18.10.2026 (Phase 3)
- **Bezug:** ADR 0001 §3 (Signal, dark-first), ADR 0002 (CSS Custom Properties + CSS Modules), ADR 0008 (CSP ohne Inline-Scripts)
- **Dateien:** `design/tokens.css`, `design/fonts/`, `design/preview/`

Das Design-System übernimmt die Marke **Signal** aus `rxf-sys/www.rxf-sys.de`
und erweitert sie für ein Betriebs-Dashboard:

- dichtere Tabellen und Bedienelemente
- semantische Statusfarben, getrennt vom Akzent
- Diagrammpalette
- Motion-Regeln

Dunkel ist das Primär-Theme, hell wird vollständig unterstützt.

`tokens.css` ist die einzige Quelle für Farben, Typo, Abstände und Motion.
Phase 4 übernimmt die Datei unverändert in `apps/web`; Komponenten nutzen
ausschließlich die Variablen, nie Hex-Werte.

## Vorschau öffnen

```bash
cd design && python3 -m http.server 8765 --bind 127.0.0.1
# http://127.0.0.1:8765/preview/index.html
```

`preview/index.html` funktioniert auch direkt per `file://`, weil die Vorschau nur
klassische Scripts nutzt.

Die Vorschau ist ein Wegwerf-Prototyp in Vanilla-JS ohne Build und ohne
Dependencies. Sie legt Aussehen und Verhalten fest, aber nicht den Code: Phase 4
baut alles in React neu.

| URL-Parameter | Werte | Wirkung |
|---|---|---|
| `data` | `demo`, `worst`, `empty` | Datensatz: normal, Härtefall (500 Gäste, lange und Unicode-Namen, 23 Alarme, Fehler), leer |
| `theme` | `dark`, `light` | Theme erzwingen; sonst gilt `prefers-color-scheme` |
| `chrome` | `0` | Devbar und Varianten-Picker ausblenden (für Screenshots) |
| `login` | `normal`, `error`, `locked`, `2fa`, `setup` | Zustand der Anmeldeseite |
| `card` | `calm`, `dense`, `status` | Kartenvariante im Dashboard |
| `cat` | `grid`, `list`, `groups` | Katalogansicht im Onboarding |

Ansichten:

- `#/` (Übersicht)
- `#/login`
- `#/onboarding/{catalog,connect,permissions,layout}`
- `#/dashboard`, `#/dashboard/edit`
- `#/p/proxmox-ve/guests`, `#/p/proxmox-ve/guests/104`
- `#/settings/infrastructure`

## Regeln

1. **Akzent ist Fläche, kein Text auf hell.**
   - `#FFC21A` auf Weiß hat nur 1,62:1.
   - Auf hell trägt Gelb nur Flächen (Primärknopf, aktiver Schritt, Auswahlrahmen); Text darauf ist `--on-accent`.
   - Auf dunkel darf `--accent-ink` Text sein (10,15:1).
2. **Status nie nur über Farbe.**
   - Jeder Status hat Icon und Text (`statusEl`, `badge`).
   - Statusfarben sind reserviert und werden nie für Diagrammreihen benutzt.
3. **Kein Abschwächen per `opacity` bei Text.**
   - Veraltete Widgets und der Bearbeitungsmodus haben anfangs Text auf 3,1:1 gedimmt; axe hat das gefunden.
   - Heute gilt: veraltet zeigt ein Banner und entsättigt nur Grafiken, im Bearbeitungsmodus bleibt der Inhalt voll lesbar und ist nur nicht klickbar.
4. **Widgets schneiden nie ab und scrollen nie.**
   - Desktop: feste Zeilenhöhe. Listen (`data-fit`) kürzen sich auf das, was passt, und zählen den Rest in „N weitere“.
   - Reicht das nicht, entfallen nachrangige Blöcke ganz. Das betrifft vor allem S-Widgets im Bearbeitungsmodus.
   - Unter 720 px wachsen Widgets mit dem Inhalt.
   - Phase 4 setzt das als Hook mit `ResizeObserver` um.
5. **Schmale Widgets per Container Query.**
   - `.widget` ist ein `inline-size`-Container.
   - Unter 260 px Breite werden Kennzahlen und Statuschips kompakter.
   - Die Regel hängt an der Widgetbreite, nicht am Viewport.
6. **Zahlen deutsch.**
   - `Intl.NumberFormat('de-DE')`, kompakt als „Tsd.“, „Mio.“, „Mrd.“
   - Bytes binär (GiB, TiB)
   - Zeiten relativ („vor 12 Sekunden“), Datum TT.MM.JJJJ
   - Tabellenzahlen mit `tabular-nums`
7. **Eine Hero-Zahl je Ansicht** (`--fs-hero`), alle anderen Kennzahlen höchstens `--fs-6`.
8. **Motion nach Emil Kowalski.**
   - ease-out für Ein- und Ausblenden, nichts über 300 ms.
   - Die Befehlspalette erscheint ohne Animation, weil sie häufig benutzt wird.
   - Drücken skaliert auf 0,97.
   - Bei `prefers-reduced-motion` entfällt Bewegung; Überblendungen bleiben mit 120 ms.
9. **Semantik vor ARIA.**
   - Keine Blockelemente oder Überschriften in Buttons.
   - Jede Ansicht hat genau ein `h1` und ein `main`, Widget-Titel sind `h2`.
   - Dialoge sind native `<dialog>`.
   - Menüs und Drawer geben den Fokus an den Auslöser zurück.
10. **Gefährliche Aktionen** zeigen Risiko, Folgen und Audit-Hinweis:
    - Risiko „mittel“: bestätigen.
    - Risiko „hoch“: Namen eintippen und Passwort eingeben (Re-Auth, ADR 0005).

## Tokens

### Flächen und Text

Kontrast nach WCAG 2.2, gemessen am 18.10.2026. Alle Text-Tokens liegen auf
allen drei Flächen über 4,5:1.

| Token | Dunkel | Hell | Kontrast dunkel (bg / surface / tile) | Kontrast hell (bg / surface / tile) |
|---|---|---|---|---|
| `--bg` | `#121517` | `#F4F5F2` | – | – |
| `--surface` | `#1B2024` | `#FFFFFF` | – | – |
| `--tile` | `#252B30` | `#E9EBE6` | – | – |
| `--ink` | `#F1F2EE` | `#1C2125` | 16,31 / 14,61 / 12,73 | 14,83 / 16,23 / 13,52 |
| `--body` | `#C9CED2` | `#3B4248` | 11,56 / 10,36 / 9,03 | 9,32 / 10,20 / 8,50 |
| `--muted` | `#A9B0B6` | `#535B62` | 8,36 / 7,49 / 6,53 | 6,31 / 6,91 / 5,75 |
| `--faint` | `#8F979D` | `#626A71` | 6,18 / 5,54 / 4,83 | 5,02 / 5,50 / 4,58 |
| `--focus` | `#FFC21A` | `#1C2125` | 11,34 auf bg | 16,23 auf surface |

### Status

| Token | Dunkel | Hell | Kontrast dunkel (bg / surface / tile) | Kontrast hell (bg / surface / tile) | Badge auf `-soft` (dunkel surface/tile, hell) |
|---|---|---|---|---|---|
| `--ok` | `#57C98A` | `#1A7541` | 8,84 / 7,92 / 6,90 | 5,24 / 5,73 / 4,77 | 6,02 / 5,25, 4,92 |
| `--warn` | `#F2994A` | `#A64D08` | 8,23 / 7,38 / 6,43 | 5,21 / 5,70 / 4,74 | 5,63 / 4,86, 4,82 |
| `--crit` | `#FF8A80` | `#B3261E` | 8,03 / 7,19 / 6,27 | 5,97 / 6,54 / 5,44 | 5,52 / 4,81, 5,24 |
| `--unknown` | `#A3AAB0` | `#5F676E` | 7,80 / 6,99 / 6,09 | 5,25 / 5,75 / 4,79 | 5,43 / 4,68, 4,93 |
| `--paused` | `#8FAAC4` | `#4A6580` | 7,61 / 6,82 / 5,94 | 5,54 / 6,06 / 5,05 | 5,18 / 4,52, 5,00 |

Angepasst in Phase 3, nachdem axe 4,21:1 bei Badges gemeldet hatte:

| Token | Theme | vorher | jetzt |
|---|---|---|---|
| `--ok` | hell | `#1F7F47` | `#1A7541` |
| `--warn` | hell | `#B4540A` | `#A64D08` |
| `--unknown` | dunkel | `#98A0A6` | `#A3AAB0` |

### Diagramme

Die Palette ist die dataviz-Referenzpalette in fester Reihenfolge, nie zyklisch.
Eine neunte Reihe wird zu „Sonstige“ zusammengefasst. Es gibt immer nur eine
y-Achse.

Ergebnis von `validate_palette.js`, 18.10.2026:

| Theme | Fläche | Ergebnis | Schlechteste Werte |
|---|---|---|---|
| dunkel | `#1B2024` | alle Prüfungen bestanden | CVD ΔE 8,4 (protan), Normalsicht ΔE 19,3 |
| hell | `#FFFFFF` | bestanden mit Kontrastwarnung | `--series-3` 2,82, `--series-4` 2,17, `--series-5` 2,69 |

Die Kontrastwarnung im hellen Theme verpflichtet zu zwei Ausgleichen:

- Jedes Diagramm hat eine Legende ab zwei Reihen sowie Direktlabels.
- Jedes Diagramm hat den Schalter „Als Tabelle“.

Hover zeigt Fadenkreuz und Tooltip. Mit Tastatur: Fokus auf das Diagramm,
dann Pfeiltasten.

### Typo

Schriften liegen lokal unter `design/fonts/`, Lizenz OFL-1.1 (siehe
`LICENSE-*.txt`), kein CDN:

- Archivo (variabel, Überschriften)
- Atkinson Hyperlegible Next (Text)
- Atkinson Hyperlegible Mono (IDs, IPs, Tokens)

| Token | Größe | Einsatz |
|---|---|---|
| `--fs-1` | 12 px | Achsen, Mikrolabels |
| `--fs-2` | 13 px | Meta, Tabellen-Zusatz |
| `--fs-3` | 14 px | Tabellenzellen, dichte UI |
| `--fs-4` | 15 px | Standard-UI und Fließtext |
| `--fs-5` | 17 px | Widget-Titel, Betonung |
| `--fs-6` | 20 px | Abschnitte, Kennzahlen |
| `--fs-7` | 26 px | Seitentitel (Archivo) |
| `--fs-8` | 34 px | Login und Onboarding (Archivo) |
| `--fs-hero` | 48 px | die eine Hero-Zahl |

### Abstände, Radien, Größen

| Gruppe | Werte |
|---|---|
| Abstand `--sp-1` … `--sp-10` | 4, 8, 12, 16, 20, 24, 32, 40, 56, 72 px |
| Radien | Karte 22, innen 14, Control 12, klein 8, Pille 999 |
| Controls | Höhe 40 (klein 32), Zeile 40 (Touch 48), Mindest-Trefferfläche 44 |
| Layout | Sidebar 248, Inhalt max. 1680, Rasterzeile 156 (unter 720 px automatisch), Abstand 16 |

### Motion

| Token | Wert | Einsatz |
|---|---|---|
| `--dur-1` | 150 ms | Hover, Tooltips |
| `--dur-2` | 200 ms | Menüs, Popover |
| `--dur-3` | 250 ms | Dialoge, Drawer |
| `--dur-4` | 300 ms | Obergrenze |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Ein- und Ausblenden |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Drawer |

## Raster und Breakpoints

| Breite | Spalten | Verhalten |
|---|---|---|
| ab 1280 px | 12 | S = 3 × 1, M = 6 × 2, L = 6 × 3, XL = 12 × 2 (Spalten × Zeilen) |
| 900–1279 px | 6 | S = 3 Spalten, alles andere volle Breite |
| 720–899 px | 6 | Sidebar wird Drawer, Krümelpfad zeigt nur das letzte Element |
| 520–719 px | 2 | Widgets mit Inhaltshöhe |
| unter 520 px | 1 | Aktionsleisten als Raster, Onboarding-Schritte als „Schritt N von 6“ |

## Varianten (Picker)

Die Vorschau zeigt zwei Entscheidungen als Varianten. Sie lassen sich über
den Picker unten wechseln, mit den Tasten 1–3 oder den Pfeiltasten.
Bildvergleich: `screenshots/variants-card-style.jpg` und
`screenshots/variants-catalog.jpg`.

| Entscheidung | Variante | Stärke | Schwäche |
|---|---|---|---|
| Kartenstil Dashboard | **Ruhig** (Standard) | Signal-typisch, viel Luft, Icon + Quelle im Kopf | zeigt am wenigsten pro Bildschirm |
| | **Dicht** | kleinere Köpfe und Abstände, mehr Inhalt je Widget, flache Karten mit Linie | wirkt technischer, weniger Marke |
| | **Statusleiste** | Status-Chip im Kopf, Quelle und Alter im Fuß; schnellstes Scannen | Fuß kostet Höhe, S-Widgets verlieren den Fuß |
| Katalog Onboarding | **Raster** (Standard) | Beschreibung sichtbar, gut bei 10–20 Plugins | lang auf dem Handy |
| | **Liste** | zeigt „Du brauchst: …“ je Plugin, kompakt | weniger einladend |
| | **Gruppiert** | ordnet nach Kategorie, skaliert auf viele Plugins | mehr Scrollen bei wenigen Plugins |

**Entschieden (19.10.2026):**

- Kartenstil „Ruhig“ ist Standard, „Dicht“ ist eine Benutzereinstellung.
- „Statusleiste“ entfällt.
- Katalog „Raster“; „Liste“ und „Gruppiert“ entfallen.

## Prüfnachweise (18.10.2026)

Werkzeuge:

- Playwright mit Chromium
- axe-core 4.14, mit Tags `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa` und `best-practice`

Die Skripte liegen nicht im Repo; Phase 4 übernimmt die Prüfungen in die
Playwright-Suite. Übersichtsbilder aller Ansichten bei 1440 und 390 px, je
dunkel und hell, liegen unter `screenshots/views-*.jpg`.

| Prüfung | Umfang | Ergebnis |
|---|---|---|
| axe | 19 Zustände (11 Ansichten, 4 Login-Zustände, Worst case, leer) × 2 Breiten × 2 Themes, dazu Dialoge, Drawer, Menü, Palette, mobile Navigation | 0 Verstöße, auch nicht „moderate“/„minor“ |
| Interaktion | Tastatur-Verschieben, Rückgängig/Wiederholen, Größe, Entfernen, Palette, Menü, Bestätigung mittel/hoch, Toasts, Diagramm per Tastatur, Tabellen-Suche/Sortierung, TOFU, mobile Navigation, Sprunglink | 50 von 50 |
| Abschneiden in Widgets | 6 Breiten × 2 Datensätze × 3 Kartenvarianten, dazu Bearbeitungsmodus | nichts abgeschnitten |
| Horizontaler Überlauf | alle Ansichten × 3 Datensätze bei 390, 768, 1024, 1440 px | keiner |
| Konsole | alle Ansichten und Interaktionen | keine Fehler |

### Härtetest (break-ui) und Korrekturen

**Gebrochen**, jetzt behoben:

- Listen-Widgets schnitten bei festen Zeilenhöhen Einträge und den Link „N weitere“ ab (Worst case, Tablet, Handy). Lösung: Regel 4.
- Lange Speichernamen schoben Meter und Dienstkacheln aus dem Widget. Ursache: Grid-Items mit `min-width: auto`.
- Onboarding lief auf 390 und 1024 px horizontal über, weil die Schrittleiste nicht umbrechen konnte.
- Der Benutzer-Chip schob den Abmelden-Knopf aus der Sidebar, weil die Spalte nicht schrumpfte.
- Nach dem Ablegen eines Widgets per Tastatur ging der Fokus verloren.
- Für Hochrisiko-Aktionen reichte der eingetippte Name, das Passwort war nicht Pflicht.
- Der Link „Zum Inhalt springen“ setzte den Hash auf `#main`, der Router sprang dadurch zur Übersicht. Außerdem war der Link beim Fokussieren unsichtbar.

**Hässlich**, jetzt behoben:

- Gäste-Widget in S mit drei Kennzahlen
- „voll etwa am morgen“
- Statuslabels ohne Auslassungszeichen
- „1 von 5“ brach getrennt um
- Instanz-Reiter „in Arbeit“ zweizeilig

**Fragil**, jetzt behoben:

- Überschriften und Absätze in Buttons
- fehlendes `main` auf Login und Übersicht
- Logo-Link ohne Namen
- Suchknopf ohne Namen auf dem Handy
- Plus-Knopf innerhalb der Tablist

**Gehalten hat:**

- 500 Gäste mit Paginierung
- Unicode-Namen (Đặng-Thị-Ngọc-Hân)
- 23 Alarme
- leere Zustände mit nächstem Schritt
- Fehler-, Lade- und Veraltet-Zustände je Widget
- Kontrast der Text-Tokens

## Übergabe an Phase 4

- `tokens.css` und `fonts/` nach `apps/web/src/styles/` übernehmen. Die `@font-face`-Pfade bleiben relativ.
- Die Fit-Logik (Regel 4) wird ein `useFitList`-Hook. Container Queries bleiben CSS.
- Dialoge auf Radix, Palette auf cmdk, Toasts auf sonner. Verhalten wie in der Vorschau, Fokus-Rückgabe inklusive.
- axe- und Interaktionsprüfungen dieser Phase als Playwright-Tests übernehmen.
