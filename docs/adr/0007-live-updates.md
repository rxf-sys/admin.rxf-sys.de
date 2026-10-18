# ADR 0007 – Live-Updates und adaptive Abfragefrequenz

- **Status:** Akzeptiert (18.10.2026)
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §5.3 (Live-Updates), §7, §9 (Geräte schonen); ADR 0003 (Collectors)

## Kontext

Das Dashboard soll sich ohne Neuladen aktualisieren. Gleichzeitig sollen
Geräte geschont werden: Schaut niemand zu, sinkt die Abfragefrequenz.
Der Weg zum Browser führt über Cloudflare Tunnel und Caddy.

## Optionen

| Option | Bewertung |
|---|---|
| **Server-Sent Events + TanStack-Query-Invalidierung** | einfach, HTTP-basiert, automatische Wiederverbindung, ein Kanal Server → Browser reicht |
| WebSocket | bidirektional, aber mehr Protokoll-Code; Rückkanal wird nicht gebraucht (Befehle laufen über REST) |
| Polling im Browser | einfach, aber Last proportional zur Zahl offener Tabs |

## Entscheidung

**SSE-Endpunkt `GET /api/stream`**, authentifiziert per Sitzungs-Cookie.

### Ereignisse

| Ereignis | Daten | Wirkung im Browser |
|---|---|---|
| `entities` | `instanceId`, `kinds[]`, `version` | invalidiert passende Query-Keys (`['entities', instanceId, kind]`) |
| `metrics` | `seriesIds[]`, `until` | invalidiert Zeitreihen-Queries im sichtbaren Fenster |
| `instance` | `instanceId`, `status`, `health` | aktualisiert Plugin-Status (pausiert, Fehler, Circuit Breaker offen) |
| `alert` | `ruleId`, `entityId`, `state` | aktualisiert Alarm-Widgets, Toast bei neuen `crit` |
| `job` | `jobId`, `progress`, `state`, `result` | Fortschritt und Ergebnis-Toast für Aktionen |
| `session` | `revoked` | erzwingt Abmeldung im Tab |

Der Server sendet **keine Nutzdaten der Entitäten**, nur „hat sich
geändert“. Der Browser holt Daten über die normale API (mit Rollenprüfung).
So gibt es nur einen Pfad für Berechtigungen und Caching.

### Technik

- `Content-Type: text/event-stream`, `Cache-Control: no-store`, keine
  Kompression; Heartbeat-Kommentar alle 25 s (Cloudflare beendet
  inaktive Verbindungen nach etwa 100 s).
- `id` je Ereignis; bei Wiederverbindung mit `Last-Event-ID` liefert der
  Server verpasste Ereignisse aus einem Ringpuffer (5 min), sonst ein
  `resync`, das alle sichtbaren Queries invalidiert.
- Caddy leitet `/api/stream` ohne Puffer weiter (`flush_interval -1`).
- Je Tab eine Verbindung; das Limit von sechs Verbindungen je Host gilt
  bei HTTP/2 (Cloudflare) nicht.

### Wer schaut zu? (adaptive Frequenz)

- Beim Verbinden und bei jeder Änderung der sichtbaren Widgets/Seiten
  sendet der Browser `POST /api/stream/watch` mit den sichtbaren
  `instanceId`s (IntersectionObserver + `document.visibilityState`).
- Der Kern führt je Instanz einen Zähler „Zuschauer“. Ist er > 0, laufen
  deren Collectors im Takt `interval.active`, sonst `interval.background`.
  Wechsel nach oben greifen sofort (ein Lauf wird vorgezogen), nach unten
  nach 60 s Karenz.
- Wird ein Tab unsichtbar, meldet er nach 30 s „nichts sichtbar“.
- Alarme hängen nicht vom Zuschauen ab: Der Hintergrundtakt ist so
  gewählt, dass Ausfall-Alarme spätestens nach 2 min auslösen.

## Folgen

- Die API braucht stabile Query-Keys; sie werden in `@rxf/contracts`
  definiert und von Server (Ereignisse) und Web (Queries) geteilt.
- Ein langsamer Browser blockiert den Server nicht: Pro Verbindung gibt es
  einen begrenzten Puffer; läuft er voll, wird die Verbindung geschlossen
  und der Browser verbindet sich mit `resync` neu.
- Stream-Collectors (Docker `/events`, HA WebSocket) laufen unabhängig vom
  Zuschauer-Zähler dauerhaft (Owner-Entscheidung vom 17.10.2026 für HA).
