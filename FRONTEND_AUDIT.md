# Frontend-Audit — admin.rxf-sys.de

Stand: 2026-06-08 · Branch `claude/affectionate-gauss-bVelI`
Umfang: `frontend/src` (~9.700 LOC, 30 Komponenten, 6 Hooks, API-Client)

> **Status: alle Funde umgesetzt** (Commit folgt). Kurzüberblick:
> - **P1** Cache-Key-Bug gefixt (`STORAGE_KEY` exportiert + verwendet), Settings-Sync
>   feuert jetzt einen Warn-Toast (entdrosselt).
> - **P2** Alle `window.confirm` (AdminPanel 3×, SettingsPage 1×) → `ConfirmModal`.
>   `ServiceFormModal` hat `role="dialog"`/`aria-modal`. Neuer `useFocusTrap`-Hook
>   in allen 4 Modals + Drawer.
> - **P3** Toast-Timer werden bei Unmount geräumt, `parseAuditEvents`-Runtime-Guard
>   im Drawer, `ServiceGrid`-History räumt gelöschte Services.
> - **P4** `@vitest/coverage-v8` + `test:cov`-Script, 19 neue Tests
>   (`AttentionHero` Health-Logik + `useFocusTrap`). 57/57 grün, ~59% Coverage.

## Status quo (gut)

- **Tests grün**: 38/38 in 9 Test-Dateien. CI läuft `tsc -b` + `eslint` + `vitest` + `build`.
- **Type-Safety solide**: kein einziges `any` im Code, nur 3 dokumentierte `as unknown as`-Casts.
- **Modals überwiegend a11y-konform**: `ConfirmModal`, `Drawer`, `CommandPalette` haben
  alle `role="dialog"` + `aria-modal` + Escape-Handler + Initial-Focus + AbortController-Cleanup.
- **Error-States in Daten-Sektionen**: `BackupsSection` z.B. setzt sauber
  `heatmapError`/`storageError`/`scheduleError` und respektiert `signal.aborted`.

Das Frontend ist insgesamt in gutem Zustand. Die folgenden Punkte sind die echten,
verifizierten Lücken — nach Impact sortiert.

---

## P1 — Echte Bugs (sollten gefixt werden)

### 1. Cache-Leeren löscht die Einstellungen, die es zu behalten verspricht
`src/components/SettingsPage.tsx:199-204`

```ts
if (!window.confirm('Lokalen Cache + Verlauf leeren? Theme + Polling-Einstellungen bleiben erhalten.')) return;
const keep = localStorage.getItem('rxf-ui');   // ❌ falscher Key
localStorage.clear();
if (keep) localStorage.setItem('rxf-ui', keep); // ❌ schreibt leeren Key zurück
```

`useTheme.ts:35` speichert unter `STORAGE_KEY = 'rxf-admin-ui'`. Der Erhalt-Code liest
`'rxf-ui'` (existiert nicht) → `localStorage.clear()` wischt auch Theme + Polling weg.
Der Dialog-Text ist damit faktisch falsch.
**Fix**: Key auf `'rxf-admin-ui'` korrigieren (oder `STORAGE_KEY` importieren).

### 2. Settings-Sync schluckt Fehler komplett
`src/App.tsx:117`

```ts
api.putAccountSettings(ui as unknown as Record<string, unknown>).catch(() => {});
```

Schlägt die geräteübergreifende Persistenz fehl, erfährt der Nutzer nichts — die UI
suggeriert, alles sei gespeichert. **Fix**: bei Fehler einen dezenten Toast
(„Einstellungen konnten nicht synchronisiert werden") feuern.

---

## P2 — UX / A11y-Inkonsistenzen

### 3. `window.confirm()` trotz vorhandenem `ConfirmModal`
`src/components/AdminPanel.tsx:40,59,88` · `src/components/SettingsPage.tsx:199`

Destruktive Admin-Aktionen (Token revoken, Rolle ändern, **Konto löschen**) nutzen den
nativen Browser-Dialog, während Backup-Verify bereits über das gestylte `ConfirmModal`
läuft (`App.tsx:232`). Inkonsistentes Look-and-Feel, schlechter auf Mobile, nicht
themebar. **Fix**: die 4 Stellen auf `ConfirmModal` umstellen.

### 4. `ServiceFormModal` fehlen Dialog-Rollen
`src/components/ServiceFormModal.tsx:73-74`

Hat Escape-Handler, aber im Gegensatz zu den anderen drei Modals **kein**
`role="dialog"` / `aria-modal="true"`. Screenreader behandeln es als normalen Content.
**Fix**: Attribute auf das `.modal`-Element ergänzen.

### 5. Kein Focus-Trap in Modals
`ConfirmModal`, `Drawer`, `ServiceFormModal`, `CommandPalette`

Alle setzen Initial-Focus + Escape, aber Tab/Shift-Tab kann aus dem offenen Modal
herauswandern (in den dahinterliegenden, eigentlich inerten Content). **Fix**: kleiner
Shared-Hook `useFocusTrap(ref)` oder `inert` auf den Hintergrund.

---

## P3 — Robustheit / Wartbarkeit

### 6. Toast-Timeout ohne Cleanup
`src/App.tsx:89`

```ts
setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), 4500);
```

Kein `clearTimeout` bei Unmount → seltenes „setState after unmount" beim Logout
(Dashboard remountet via `key`). **Fix**: Timer-IDs in einem Ref sammeln und im
Cleanup leeren.

### 7. Ungeprüfter Event-Cast
`src/components/Drawer.tsx:113`

```ts
const all = r.events as unknown as AuditEvent[];
```

`api.events()` liefert `Record<string, unknown>[]` — bei API-Shape-Änderung kein
Compile-Fehler, sondern Render-Crash. **Fix**: schmale Runtime-Guard-Funktion oder
zod-artige Validierung an der API-Grenze.

### 8. `ServiceGrid`-History wird für gelöschte Services nie geräumt
`src/components/ServiceGrid.tsx:16-23`

Das modulglobale `history`-Objekt cappt pro Service auf 60 Samples (gut), entfernt aber
nie Einträge gelöschter Services. Praktisch unkritisch (gebunden an Service-Anzahl),
aber unsauber als Modul-State. **Fix**: bei Sample-Push Keys gegen aktuelle `services`
abgleichen, oder in einen `useRef` ziehen.

### 9. Stille `.catch(() => { /* row stays blank */ })`
`src/components/SettingsPage.tsx:823,931` · `src/components/GuestDrawer.tsx:69,75,462`

Nutzer kann „lädt noch" nicht von „Fehler" unterscheiden. Niedrige Priorität, aber
ein „—"-Platzhalter mit Title-Tooltip wäre ehrlicher.

---

## P4 — Test-Coverage (größte strukturelle Lücke)

- **9 von 30 Komponenten getestet.** Ungetestet u.a.: `AttentionHero` (enthält die
  **Health-Score-Logik** mit den kürzlich geänderten RAM/CPU-Schwellen!), `NetworkPanel`,
  `BackupsSection`, `SettingsPage`, `AdminPanel`, `VMTable`, `useAuth`.
- **Kein Coverage-Tooling**: `@vitest/coverage-v8` fehlt, `npx vitest run --coverage`
  bricht ab. Backend hat eine 70%-Gate — Frontend hat keine.
- **Empfehlung**:
  1. `@vitest/coverage-v8` als devDependency + `"test:cov"`-Script.
  2. Unit-Tests für die reine Logik zuerst: `deriveAlerts`/`computeHealth` in
     `AttentionHero` (pure Funktionen, hoher Wert/Aufwand-Ratio).
  3. Optional eine Coverage-Schwelle in CI (z.B. 50% Start, dann anheben).

---

## Korrektur zu einer früheren Annahme

Eine erste automatisierte Durchsicht meldete „silent fetch errors in BackupsSection" —
das ist **falsch**: die Sektion behandelt Fehler korrekt mit eigenen Error-States.
Ebenso wurden „any-Verwendung" und „Modals ohne a11y" gemeldet, die sich bei
Verifikation nicht bestätigt haben. Die obige Liste enthält nur am Code geprüfte Funde.

---

## Vorgeschlagene Reihenfolge

| # | Aufwand | Datei |
|---|---|---|
| 1 Cache-Key-Bug | ~5 min | SettingsPage.tsx |
| 2 Settings-Sync-Toast | ~10 min | App.tsx |
| 3 window.confirm → ConfirmModal | ~30 min | AdminPanel.tsx, SettingsPage.tsx |
| 4 ServiceFormModal Dialog-Rollen | ~5 min | ServiceFormModal.tsx |
| 6 Toast-Cleanup | ~10 min | App.tsx |
| P4 Coverage-Tooling + AttentionHero-Tests | ~1 h | neu |
| 5 Focus-Trap-Hook | ~45 min | neu, shared |
| 7/8/9 Robustheit | ~1 h | diverse |
