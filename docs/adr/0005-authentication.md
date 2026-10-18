# ADR 0005 – Authentifizierung, Sitzungen und Rollen

- **Status:** Akzeptiert (18.10.2026): eigene Umsetzung, 2FA Pflicht für alle Konten
- **Datum:** 17.10.2026
- **Bezug:** Auftrag §5.1, §5.5, §8; `docs/analysis/legacy-core.md` §2 (Lehren 1–3, 6, 7, 14–16); ADR 0006

## Kontext

Anforderungen: Erststart nur über einen Setup-Code aus dem Log (kein
Bootstrap-Passwort per ENV), Passwort (Argon2id) plus 2FA mit TOTP und
Passkeys, Backup-Codes, Sitzungsliste mit „überall abmelden“, Sperre mit
Backoff, Rotation beim Login, Re-Authentifizierung für gefährliche Aktionen
und Secret-Änderungen, CSRF-Schutz, Rollen `admin`/`operator`/`viewer`
serverseitig geprüft. Das Altsystem hat eine eigene Umsetzung, die in drei
Audits gehärtet wurde.

## Optionen

| Kriterium | Better Auth 1.7 | Eigene Umsetzung nach OWASP ASVS 5 (L2) |
|---|---|---|
| Abdeckung | Sessions, Username-, Two-Factor- (TOTP, Backup-Codes), Passkey-, Admin-Plugin (Rollen), Rate-Limit | alles, was wir brauchen, nichts darüber hinaus |
| Passt zu unseren Flows? | Setup-Code, Re-Auth-Fenster, Rollen-Regeln für Aktionen und Audit müssen über Hooks nachgebaut werden; Modell ist E-Mail-zentriert | ja, Flows werden genau so gebaut |
| Sicherheitslage | **37 veröffentlichte Advisories**, darunter 2026 mehrere *critical*/*high* (z. B. 30.09.2026 „OAuth state can be used as a Magic Link to sign in as another user“, 26.06.2026 „Attacker's password keeps working after magic link or email OTP sign-in“); viele betreffen Plugins, die wir nicht nutzen würden | Angriffsfläche nur aus unserem Code + drei reifen Primitiven; Review-Aufwand bei uns |
| Abhängigkeiten | `better-auth` (~2 MB) + `@better-auth/passkey` (+ `@simplewebauthn/*` intern); Web-Client 16,6 KB gz | `@node-rs/argon2`, `otpauth`, `@simplewebauthn/server`, `@simplewebauthn/browser` (2,8 KB gz) |
| Aufwand | geringer für Standard-Flows, höher für unsere Sonderfälle | höher (ca. 2–3 Tage zusätzlich), aber vollständig testbar |
| Updates | häufige Releases, Breaking Changes in Minor-Versionen möglich | stabil, Primitive ändern sich selten |

Quelle der Advisories: https://github.com/better-auth/better-auth/security/advisories (abgerufen 17.10.2026).

## Entscheidung

**Eigene Umsetzung auf Basis von `@node-rs/argon2`, `otpauth` und
`@simplewebauthn/*`**, gegen OWASP ASVS 5 Level 2 geprüft. Begründung: Die
Sonderflows (Setup-Code, Re-Auth, Aktionsrollen, Audit) machen den
Bibliotheksvorteil klein, die Advisory-Historie zeigt eine große
Angriffsfläche, und das Projekt hat bereits eine gehärtete eigene Umsetzung,
deren Lehren übernommen werden.

### Erststart (Setup-Code)

1. Existiert kein aktiver Admin, erzeugt der Server beim Start einen
   Setup-Code (20 Zeichen Base32, 100 Bit) und schreibt ihn **einmal** gut
   sichtbar ins Log. Gespeichert wird nur der SHA-256-Hash mit Ablauf 24 h;
   nach Ablauf erzeugt der nächste Start einen neuen Code.
2. `POST /api/setup` mit Code, Benutzername und Passwort legt den ersten
   Admin an und schließt den Setup dauerhaft (`setup_state.completed_at`).
   Danach antwortet der Endpunkt immer 404.
3. Versuche sind gedrosselt (5 je 5 min je IP, 20 je Stunde global).
4. Direkt danach erzwingt die App die Einrichtung des zweiten Faktors.

### Passwörter

- Argon2id mit `m = 19 MiB, t = 2, p = 1` (OWASP-Mindestwert). Höchstens
  zwei Hash-Berechnungen gleichzeitig (Semaphore), damit Logins das
  RAM-Budget (< 200 MB) nicht sprengen.
- Länge 12–128 Zeichen, Unicode NFKC, keine Kompositionsregeln; Abgleich
  mit einer Liste häufiger Passwörter (offline, im Paket).
- Gleiche Antwortzeit für unbekannte, deaktivierte und falsche Konten
  (Dummy-Hash, Lehre #6).

### Zweiter Faktor

- **Pflicht für alle Konten** (Owner-Entscheidung 18.10.2026): Wer noch
  keinen zweiten Faktor hat, kann nach dem Login nur dessen Einrichtung
  aufrufen.
- **TOTP** (RFC 6238, SHA-1, 6 Stellen, 30 s, ±1 Schritt) mit
  Replay-Schutz über den zuletzt genutzten Zeitschritt (Lehre #3). Das
  TOTP-Secret wird verschlüsselt gespeichert (ADR 0006; im Altcode Klartext).
- **Passkeys** (WebAuthn, `userVerification: required`) als zweiter Faktor
  oder als alleiniger Login (zählt als MFA). RP-ID ist der Hostname der
  Instanz. Weil Passkeys an die RP-ID gebunden sind, müssen auf
  `admin-next.rxf-sys.de` registrierte Passkeys nach dem Domain-Umstieg neu
  angelegt werden; Passwort + TOTP funktionieren weiter.
- **Backup-Codes:** 10 Codes à 10 Zeichen Base32, nur SHA-256 gespeichert,
  einmalig nutzbar, Neuerzeugung nur mit Re-Auth.
- Notfall: Ein Admin kann den zweiten Faktor eines anderen Kontos
  zurücksetzen. Für den letzten Admin gibt es ein CLI-Kommando im Container
  (`rxf admin reset-2fa <user>`, analog zu `tools.promote_admin` im Altcode).

### Sperre mit Backoff

- Je Konto: ab 5 Fehlversuchen Wartezeit 30 s, verdoppelt bis 15 min; nie
  dauerhaft gesperrt (sonst DoS gegen den Admin).
- Je IP: 20 Fehlversuche in 10 min → HTTP 429.
- Zustand in `login_attempts` (persistent, begrenzt, alte Einträge werden
  geräumt – Lehre #7). Client-IP aus `CF-Connecting-IP` nur, wenn der
  Proxy-Pfad als vertrauenswürdig konfiguriert ist (Lehre #16).

### Sitzungen

- Token: 256 Bit Zufall, Cookie `__Host-rxf_session`
  (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). In der DB nur SHA-256
  plus 8-stelliges Präfix (Lehre #14).
- Leerlauf-Timeout 12 h, absolute Lebensdauer 7 Tage.
- **Rotation** bei Login, nach Abschluss des zweiten Faktors und bei
  Rollenwechsel; die alte Sitzung wird sofort widerrufen (Lehre #2).
- Sitzungsliste je Konto (erstellt, zuletzt aktiv, IP, Gerät) mit
  „abmelden“ und „überall abmelden“.

### Re-Authentifizierung („Sudo-Modus“)

Riskante Vorgänge verlangen eine Bestätigung der Identität innerhalb der
letzten 10 min (Passwort + zweiter Faktor oder Passkey):
Aktionen mit `risk: high`, Ändern oder Rotieren von Secrets, Ändern von
Zielen (Hosts/URLs), Konten- und Rollenverwaltung, Ändern des eigenen
zweiten Faktors. Gespeichert als `sessions.elevated_until`.

### CSRF

- Synchronizer-Token je Sitzung, abrufbar über `GET /api/auth/session`,
  Pflicht als Header `X-CSRF-Token` bei allen nicht lesenden Methoden.
- Zusätzlich müssen `Origin` (falls gesendet) und `Sec-Fetch-Site`
  (`same-origin`) passen.

### Rollen und Rechteprüfung

| Rolle | Darf |
|---|---|
| `viewer` | alles lesen außer Audit-Log und Kontenverwaltung; eigene Boards |
| `operator` | wie `viewer`, dazu Aktionen, deren Mindestrolle `operator` ist, **nur** auf Instanzen, für die der Admin Aktionen freigeschaltet hat |
| `admin` | alles, inklusive Plugins, Secrets, Ziele, Konten, Audit-Log |

- Jede Route deklariert in ihrer Fastify-Konfiguration `auth: { role, csrf,
  elevated }`. **Default deny:** Ein Test lädt alle registrierten Routen und
  schlägt fehl, wenn eine Route keine Deklaration hat (Lehre #15).
- Rollen werden nur serverseitig entschieden; das UI blendet nur aus.

### Audit

Alle Auth-Ereignisse landen im Audit-Log: Setup, Login (Erfolg/Fehler,
ohne Passwort), 2FA-Änderungen, Sitzungs-Widerruf, Rollenwechsel,
Re-Auth.

## Folgen

- Ohne Better Auth entfallen dessen Web-Client (16,6 KB gz) und die
  Abhängigkeit von dessen Release-Takt.
- Die Auth-Module bekommen Integrationstests für jeden Flow und eine
  ASVS-Checkliste in `docs/SECURITY.md` (Phase 4, Review in Phase 8).
- Vor jedem PR, der Auth berührt: `security-review`-Skill (Auftrag §8).
