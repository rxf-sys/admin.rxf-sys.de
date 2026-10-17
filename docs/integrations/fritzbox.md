# AVM FRITZ!Box (`fritzbox`)

> Stand: 17.10.2026 · Quellen: [D] Primärquelle · [A] Altcode · [S] nur Websuche · [?] unbestätigt · [D*] Sekundärquelle geöffnet (gepflegte Bibliothek / Integration auf GitHub, **nicht** AVM)
>
> avm.de, fritz.com und fritz.support sind per DNS gesperrt. Die AVM-PDFs (TR-064 First Steps, Service-SCPDs, AHA-HTTP-Interface, Technical Note Session-ID) waren nur über Suchsnippets erreichbar, daher [S]. Technische Details stammen überwiegend aus `kbr/fritzconnection`, den Home-Assistant-Integrationen `fritz`/`fritzbox`, `pyfritzhome`, dem openHAB-TR-064-Binding und ioBroker-Adaptern [D*]. Ein [D] gibt es in dieser Datei nicht.

## Überblick

- Kategorie: Router
- Zweck: Internetverbindung (Status, Sync-Raten, externe IPs, Uptime), Box-Firmware, Heimnetz-Geräte, Anrufliste und DECT-Smart-Home (Thermostate, Steckdosen) anzeigen. Reconnect, Gast-WLAN, Reboot und Steckdose schalten als opt-in-Aktionen.
- Nur lokal: TR-064 ist laut AVM nur aus dem eigenen LAN nutzbar [S]. Remote-TR-064 über MyFRITZ existiert [S], wird nicht genutzt.
- Versionen: Empfohlen ab FRITZ!OS 7.24, weil dort Benutzername-Pflicht und PBKDF2-Login gelten [D*][S]. Ab 7.25 ist für TR-064 ein Benutzerkonto Pflicht [D*]. `X_AVM-DE_GetHostListPath` gibt es laut AVM-Changelog seit 09.01.2017 [D*]. Für Smart Home gibt es ab FRITZ!OS 8.2 zusätzlich eine neue REST-API [S].

| Schnittstelle | Port | Auth | Liefert |
|---|---|---|---|
| TR-064 (SOAP) | 49000 http / 49443 https | HTTP Digest | WAN, DSL, Hosts, WLAN, Anrufliste, Reboot, Reconnect [D*] |
| IGD/UPnP (SOAP, `igddesc.xml`) | 49000 | ohne Login [?] | IPv6-Adresse/-Präfix, Live-Byte-Raten [D*] |
| AHA-HTTP (Web-Oberfläche) | 80 / 443 | Session-ID (`login_sid.lua`) | Smart-Home-Geräte, Schalten [D*] |

## Verbindung & Auth

- **Discovery:** `GET http://<box>:49000/tr64desc.xml` ohne Login. Liefert Service-Liste, `controlURL`/`SCPDURL` je Service und die Firmware (`systemVersion`) [D*]. IGD-Dienste stehen in `igddesc.xml` [D*]. Control-URLs immer daraus lesen, nie fest verdrahten.
- **TR-064-Aufruf:** `POST <controlURL>` mit Headern `soapaction: <serviceType>#<Action>`, `content-type: text/xml`, `charset: utf-8` und SOAP-1.1-Envelope (`<u:Action xmlns:u="<serviceType>">`). Auth ist HTTP Digest (`HTTPDigestAuth`) [D*].
- **TLS-Port** per `DeviceInfo:1` `GetSecurityPort` → `NewSecurityPort` [D*], Default 49443 [D*].
- **Benutzer:** seit 7.24 Pflicht. Ohne eigenen Admin-Namen vergibt die Box einen zufälligen `fritz…`-Namen, vorher war es `admin` [D*].
- **Fehlerformat:** SOAP-Fault mit `detail` → `errorCode`. Codes: 401 (ungültige Action), 402 (Argument), 501 (Action fehlgeschlagen), 600 (Wert), 606 (Action nicht autorisiert, fehlendes Recht), 713 (Array-Index), 714 (kein Eintrag), 820 (intern) [D*]. Nicht angemeldet: HTTP 401; angemeldet ohne Recht: 606 [S].
- **AHA-Login:** `GET /login_sid.lua?version=2` liefert XML mit `SID`, `Challenge` und `BlockTime`; `SID=0000000000000000` heißt nicht angemeldet [D*].
  - Challenge mit `2$<iter1>$<salt1>$<iter2>$<salt2>`: `h1 = PBKDF2-HMAC-SHA256(password, salt1, iter1)`, `h2 = PBKDF2-HMAC-SHA256(h1, salt2, iter2)`. Die Response ist `<salt2>$<hex(h2)>` [D*]. Die Salts liegen hex-kodiert vor [?].
  - Fallback MD5 (ab FRITZ!OS 5.50): `<challenge>-md5(utf16le("<challenge>-<password>"))` [D*][S].
  - Login per `POST` mit `username` und `response` [D*]; Logout und SID-Prüfung über dieselbe Seite [S].
- **SID-Lebensdauer:** 20 min ohne Aktivität, jede Nutzung verlängert [S]. Bei 403 neu anmelden und einmal wiederholen [D*]. Fehlversuche erhöhen die `BlockTime` [D*]. Laut älterer AVM-Note beendet ein Zugriff mit ungültiger SID alle aktiven Sitzungen [S]. Login daher serialisieren, SID nie parallel mit veraltetem Wert senden.
- **Smart-Home-Aufruf:** `GET /webservices/homeautoswitch.lua?switchcmd=<cmd>&ain=<ain>&sid=<sid>` [D*].
- **TLS:** Die Box nutzt ein selbstsigniertes Zertifikat, fritzconnection prüft es deshalb nicht [D*]. Laut Forenberichten steht die öffentliche IP im CN und das Zertifikat wird nach Neustart oder IP-Wechsel neu erzeugt [S]. Let's Encrypt gibt es nur für die MyFRITZ!-Adresse, nicht für `fritz.box` oder die LAN-IP [S].
  - Pinning ist machbar, aber fragil. Vorschlag: SPKI-Pin (öffentlicher Schlüssel statt Zertifikat-Hash), Prüfung für 49443 **und** 443. Bei Wechsel kein stiller Fallback, sondern Status `warn` und erneute Bestätigung durch einen Admin.
  - Ob der Schlüssel beim Neuerzeugen gleich bleibt: [?]. Ist das nicht so, bleibt als bewusste Admin-Option „nur LAN, HTTP 49000 + Digest“ (Passwort geht nicht im Klartext über die Leitung, Nutzdaten schon).

**Entwurf `configSchema`:**

| Feld | Typ | Pflicht | Secret | Hilfetext |
|---|---|---|---|---|
| `host` | string | ja (`192.168.178.1`) | nein | IP oder `fritz.box`. Nur dieser Host wird kontaktiert (SSRF-Allowlist) |
| `useTls` | bool | nein (true) | nein | TR-064 über 49443, AHA über 443. Aus = HTTP im LAN (nicht empfohlen) |
| `tr064Port` | int | auto | nein | wird per `GetSecurityPort` ermittelt |
| `username` | string | ja | nein | eigener Benutzer, z. B. `rxf-admin` (siehe Anleitung) |
| `password` | string | ja | ja | Kennwort dieses Benutzers |
| `tlsPin` | string (sha256) | auto | nein | SPKI-Fingerabdruck, beim Test bestätigt |
| `smartHome` | bool | nein (false) | nein | DECT-Geräte über AHA-HTTP. Recht „Smart Home“ nötig |
| `callList` | bool | nein (false) | nein | Anrufliste (personenbezogen). Recht „…Anrufliste“ nötig |
| `upnpStatus` | bool | nein (true) | nein | IPv6-Präfix und Live-Raten über UPnP. „Statusinformationen über UPnP übertragen“ muss an sein |
| `guestWlanService` | int | nein | nein | Nur falls die Auto-Erkennung des Gast-WLANs versagt (`WLANConfiguration<n>`) |

## Minimale Rechte

Rechte-Pfade aus `LANConfigSecurity:1` `X_AVM-DE_GetCurrentUser` → `NewX_AVM-DE_CurrentUserRights` (XML `<rights><path>…</path><access>none|readonly|readwrite</access>`) [D*]. In AVM-Dokumenten tragen sie Kürzel [S][D*]:

| Recht (Box-Oberfläche) | Pfad | Kürzel |
|---|---|---|
| FRITZ!Box Einstellungen | `BoxAdmin` | C |
| Sprachnachrichten, Faxnachrichten, FRITZ!App Fon und Anrufliste | `Phone` | P |
| Wählhilfe | `Dial` | D |
| Zugang zu NAS-Inhalten | `NAS` | N |
| Smart Home | `HomeAuto` | H |
| App-Instanz (über `X_AVM-DE_AppSetup`) | `App` | A |

Benötigte Rechte je Action laut ioBroker-Tabelle [D*], abgeglichen mit AVM First Steps (`ForceTermination` = C, `GetCallList` = P, ohne Angabe gilt C) [S]:

| Action | Recht |
|---|---|
| `WANIPConnection`/`WANPPPConnection` `GetInfo`, `GetStatusInfo`, `GetExternalIPAddress`, `ForceTermination` | C |
| `WANCommonInterfaceConfig` `GetCommonLinkProperties` | C, A, P, N oder H |
| `WANCommonInterfaceConfig` `X_AVM-DE_GetOnlineMonitor` | C |
| `WANDSLInterfaceConfig` `GetInfo` | C |
| `Hosts` `X_AVM-DE_GetHostListPath`, `X_AVM-DE_GetMeshListPath` | C, A oder P |
| `Hosts` `GetGenericHostEntry` | „-“ (keins) |
| `WLANConfiguration` `GetInfo` | C, A oder P |
| `WLANConfiguration` `X_AVM-DE_GetWLANExtInfo`, `SetEnable` | C oder A |
| `X_AVM-DE_OnTel` `GetCallList` | P |
| `X_AVM-DE_Homeauto` (alle) | C oder H |
| `DeviceConfig` `Reboot` | C |
| `UserInterface` `GetInfo` | „-“ |
| `DeviceInfo` `GetInfo` | nicht gelistet [?] (vermutlich C) |

### Nur lesen

- **Kernbefund:** „FRITZ!Box Einstellungen“ ist in der Oberfläche nicht in Lesen und Schreiben getrennt. Wer WAN-Status, DSL-Werte oder den Online-Monitor lesen darf (C), darf auch neu starten und reconnecten. Ein reiner Lese-Account mit vollen WAN-Daten ist über TR-064 nicht möglich [D* abgeleitet]. Das Plugin erzwingt Lesen selbst: Allowlist der Actions, Schreib-Actions nur bei freigeschalteten Aktionen.
- **Profil „Standard“ (empfohlen):** eigener Benutzer mit **FRITZ!Box Einstellungen**, ohne „Zugang auch aus dem Internet“. Optional **Smart Home** und **…Anrufliste**. Achtung: Das Häkchen bei „FRITZ!Box Einstellungen“ setzt die beiden anderen laut PC-Welt automatisch mit [S]. Nach dem Speichern prüfen und ggf. abwählen.
- **Profil „Reduziert“ (ohne C):** nur P (plus H). Damit gibt es Hostliste, WLAN-Status, Link-Status, Zugangsart, Layer1-Raten und Anrufliste. WAN-Status, IPv4 und IPv6 kommen über IGD/UPnP ohne Login [?]. Es fehlen DSL-Details, Online-Monitor, Reconnect und Reboot. Gast-WLAN-Schalten geht nur mit A.
- **Später prüfen:** `X_AVM-DE_AppSetup` `RegisterApp` mit `NewAppRight`/`NewPhoneRight`/`NewHomeautoRight` ∈ `NO|RO|RW` [D*] könnte eine echte Read-only-App-Identität ergeben. Das Registrieren selbst braucht C [?].

### Zusätzlich für Aktionen

- Reconnect und Reboot: C (`BoxAdmin` = `readwrite`).
- Gast-WLAN an/aus: C oder A.
- Steckdose schalten: H (AHA) bzw. C oder H (TR-064).

### Anleitung: Token anlegen (für den Onboarding-Assistenten)

1. **Heimnetz › Netzwerk › Netzwerkeinstellungen** (Abschnitt Heimnetzfreigaben): **Zugriff für Anwendungen zulassen** aktivieren (TR-064, ab Werk aus) [D*][S]. Für IPv6 und Live-Raten zusätzlich **Statusinformationen über UPnP übertragen** [D*]. Danach empfiehlt sich ein Neustart der Box [D*]. `[Screenshot: Netzwerkeinstellungen › Heimnetzfreigaben]`
2. **System › FRITZ!Box-Benutzer › Benutzer hinzufügen** [S]: Name `rxf-admin`, langes Zufallskennwort, „Zugang auch aus dem Internet erlaubt“ **aus**. `[Screenshot: Benutzer hinzufügen]`
3. Berechtigungen nach Profil setzen (siehe oben), speichern und kontrollieren. `[Screenshot: Berechtigungen]`
4. Im Assistenten Host, Benutzer und Kennwort eintragen, **Verbindung testen**, Fingerabdruck bestätigen. Der Test zeigt, welche Funktionen mit den vorhandenen Rechten verfügbar sind.
5. Herstellerdoku: https://fritz.com/pages/schnittstellen (TR-064, AHA-HTTP, Session-ID) und AVM-Hilfe „Benutzerkonto einrichten“ https://service.avm.de/help/en/FRITZ-Box-7590/015/hilfe_system_userkonto

## Fähigkeitsmatrix

### Daten

| Datum | Endpunkt / Methode | Kern-Entität | Intervall aktiv / Hintergrund | Quelle |
|---|---|---|---|---|
| Benutzerrechte | `LANConfigSecurity:1` `X_AVM-DE_GetCurrentUser` | – (Plugin-Health) | Test + 1 h | [D*] |
| WAN-Dienst-Typ | `Layer3Forwarding:1` `GetDefaultConnectionService` → `WANPPPConnection` (PPPoE) oder `WANIPConnection` | – | Start + 1 h | [D*] |
| Internet-Status, Uptime, IPv4 | `WANPPPConnection:1`/`WANIPConnection:1` `GetInfo` → `NewConnectionStatus`, `NewUptime`, `NewExternalIPAddress` | `Service` (WAN) | 30 s / 120 s | [D*] |
| Link, Zugangsart, Layer1-Raten | `WANCommonInterfaceConfig:1` `GetCommonLinkProperties` → `NewPhysicalLinkStatus`, `NewWANAccessType`, `NewLayer1DownstreamMaxBitRate`/`NewLayer1UpstreamMaxBitRate` (bit/s) | `Metric` | 60 s / 300 s | [D*] |
| DSL-Sync (nur DSL) | `WANDSLInterfaceConfig:1` `GetInfo` → `NewDownstreamCurrRate`/`NewUpstreamCurrRate`, `…MaxRate` (kbit/s), `NewDownstreamNoiseMargin`, `NewDownstreamAttenuation` (0,1 dB); `GetStatisticsTotal` → `NewCRCErrors`, `NewFECErrors`, `NewHECErrors` | `Metric` | 60 s / 300 s | [D*] |
| Kabel/Glasfaser-Sync | keine eigenen TR-064-Werte bekannt, nur Layer1-Raten aus `GetCommonLinkProperties` | `Metric` | wie oben | [?] |
| Live-Durchsatz | `WANCommonInterfaceConfig:1` `X_AVM-DE_GetOnlineMonitor` (`NewSyncGroupIndex=0`) → `Newds_current_bps`, `Newus_current_bps` (kommagetrennte Messreihe, Einheit vermutlich Byte/s [?]), `Newmax_ds`, `Newmax_us` | `Metric` | 30 s / 120 s | [D*] |
| Live-Raten (Alternative) | IGD `WANCommonIFC1` `GetAddonInfos` → `NewByteSendRate`, `NewByteReceiveRate`, `NewX_AVM_DE_TotalBytesSent64`/`…Received64` | `Metric` | wie oben | [D*] |
| IPv6-Adresse und -Präfix | IGD `urn:schemas-upnp-org:service:WANIPConnection:1` (`/igdupnp/control/WANIPConn1`) `X_AVM_DE_GetExternalIPv6Address`, `X_AVM_DE_GetIPv6Prefix` (+ Präfixlänge, Lifetimes) | `Service` | 300 s / 900 s | [D*] |
| Modell, Firmware, Box-Uptime | `DeviceInfo:1` `GetInfo` → `NewModelName`, `NewSoftwareVersion`, `NewUpTime`; Firmware auch ohne Login aus `tr64desc.xml` | `Host` | 300 s / 900 s | [D*] |
| Update verfügbar | `UserInterface:1` `GetInfo` → `NewX_AVM-DE_Version` | `Host` | 6 h | [D*] |
| UPnP-Status | `X_AVM-DE_UPnP:1` `GetInfo` → `NewEnable` | – (Plugin-Health) | Test + 1 h | [D*] |
| Heimnetz-Geräte | `Hosts:1` `X_AVM-DE_GetHostListPath` → `NewX_AVM-DE_HostListPath`, dann `GET <path>` → XML `<List><Item>`: IP, MAC, Active, HostName, InterfaceType, Speed, `X_AVM-DE_Guest`, `X_AVM-DE_VPN`, `X_AVM-DE_WANAccess`, `X_AVM-DE_Disallow`, `X_AVM-DE_Model` | `Client` | 60 s / 300 s (überspringen, wenn `X_AVM-DE_GetChangeCounter` unverändert [?]) | [D*] |
| Heimnetz-Geräte (Fallback) | `GetHostNumberOfEntries` + `GetGenericHostEntry(NewIndex)` je Host, Ende bei 713 | `Client` | nur wenn Pfad fehlt, max. 300 s | [D*] |
| WLAN-Netze, Gast-WLAN | `WLANConfiguration<n>:1` `GetInfo` (`NewEnable`, `NewSSID`, `NewChannel`), `X_AVM-DE_GetWLANExtInfo` (`NewX_AVM-DE_APType` = `normal`/`guest`, `…TimeoutActive`, `…TimeRemain`), `GetTotalAssociations` | `Service` | 60 s / 300 s | [D*] |
| Anrufliste | `X_AVM-DE_OnTel:1` `GetCallList` → `NewCallListURL`, dann `GET <url>&days=N` oder `&max=N` → `Call`: `Id`, `Type` (1 ein, 2 verpasst, 3 aus, 9/11 aktiv, 10 abgewiesen), `Caller`, `Called`, `Name`, `Device`, `Date`, `Duration` | Plugin-Daten | 5 min / 30 min | [D*] |
| DECT-Smart-Home | AHA `switchcmd=getdevicelistinfos` (ein Aufruf für alle): `<switch>` (`state`, `mode`, `lock`), `<powermeter>`, `<temperature>`, `<hkr>` (`tist`, `tsoll`, `absenk`, `komfort`, `battery`, `batterylow`, `windowopenactiv`, `boostactive`, `errorcode`) | `NetworkDevice`? / Plugin-Entität „SmartDevice“ + `Metric` | 30 s / 120 s | [D*] |
| Smart Home (Alternative) | TR-064 `X_AVM-DE_Homeauto:1` `GetGenericDeviceInfos(NewIndex)` / `GetSpecificDeviceInfos(NewAIN)`, ein Call je Gerät | wie oben | nur Fallback | [D*] |

### Aktionen

| Aktion | Endpunkt / Methode | Risiko | Rolle | Zusatzrecht | Quelle |
|---|---|---|---|---|---|
| Reconnect (neue IP) | TR-064 `<WAN-Dienst aus Layer3Forwarding>:1` `ForceTermination`. Fehler `DisconnectInProgress` ignorieren | high | admin | C | [D*][S] |
| Gast-WLAN an/aus | `WLANConfiguration<n>:1` `SetEnable` (`NewEnable` 0/1). `n` = Instanz mit `NewX_AVM-DE_APType == guest`, Fallback höchste Instanznummer | medium | operator | C oder A | [D*] |
| Box neu starten | `DeviceConfig:1` `Reboot` | high | admin | C | [D*] |
| Steckdose schalten | AHA `setswitchon`/`setswitchoff`/`setswitchtoggle` mit `ain`. Alternativ TR-064 `X_AVM-DE_Homeauto:1` `SetSwitch` (`NewAIN`, `NewSwitchState` `ON`/`OFF`, `TOGGLE` [?]) | medium (pro Gerät auf high setzbar) | operator | H | [D*] |
| (später) Thermostat-Soll | AHA `sethkrtsoll` | low | operator | H | [D*] |

Audit-Texte: „{user} hat Reconnect ausgelöst (alte IP {ip})“, „… Gast-WLAN ‚{ssid}‘ {an/aus}“, „… FRITZ!Box neu gestartet“, „… Steckdose ‚{name}‘ ({ain}) {an/aus}“.

### Widgets (Vorschlag)

| Widget | Inhalt | Größen |
|---|---|---|
| Internet-Status | S: online/offline + Verbindungsdauer; M: + IPv4, IPv6-Präfix, Zugangsart, Sync-Rate; L: + Live-Durchsatz-Sparkline, Störabstand/CRC (DSL), Reconnect-Knopf (falls freigeschaltet) | S/M/L |
| Gast-WLAN | S: Schalter + SSID + Restlaufzeit des Timers; M: + Anzahl verbundener Gäste | S/M |
| Smart Home | M: Steckdosen (Zustand, Leistung) und Thermostate (Ist/Soll, Batterie); L: + Energie heute, Schalter, Fenster-offen | M/L |
| Heimnetz-Geräte | S: aktive Geräte; M: Liste neu und aktiv | S/M |
| Anrufe | S: verpasste Anrufe heute; M: letzte 5 (nur Rolle ≥ operator, Datenschutz) | S/M |

### Seiten (Vorschlag)

- **FRITZ!Box › Internet:** Verlauf von Verbindung, Sync-Raten, Durchsatz und Reconnects.
- **FRITZ!Box › Heimnetz:** Hostliste, Filter aktiv/Gast/VPN.
- **FRITZ!Box › WLAN:** Netze inkl. Gast.
- **FRITZ!Box › Telefonie:** Anrufliste, standardmäßig nur `admin`/`operator`.
- **FRITZ!Box › Smart Home:** Geräte, Temperaturen, Energie.

### Alarmvorschläge

| Regel | Bedingung | Schwere |
|---|---|---|
| Internet getrennt | `NewConnectionStatus != Connected` > 60 s | crit |
| Box nicht erreichbar | 3 Polls in Folge fehlgeschlagen | crit |
| Box neu gestartet | `NewUpTime` kleiner als beim letzten Poll | warn |
| Reconnect / IP-Wechsel | `NewUptime` zurückgesetzt oder IPv4/IPv6-Präfix geändert | info |
| Sync-Rate gefallen | DS-`CurrRate` < 80 % des 7-Tage-Medians | warn |
| Leitungsfehler | `NewCRCErrors`-Zuwachs > Schwellwert/h | warn |
| Firmware-Update | `NewX_AVM-DE_Version` nicht leer > 7 Tage | info |
| Thermostat-Batterie | `batterylow = 1` | warn |
| DECT-Gerät weg | Gerät meldet „nicht vorhanden“ (`present`-Feld [?]) > 15 min | warn |
| Anmeldung gesperrt | `BlockTime > 0` oder wiederholt HTTP 401 | crit (Plugin-Health) |

## Rate-Limits & Last

- Rate-Limits sind keine dokumentiert [?]. Die Box hat wenig CPU. Home Assistant pollt `fritz` und `fritzbox` alle 30 s [D*]; das ist die Obergrenze für „aktiv“, im Hintergrund 120–300 s.
- Die API-Beschreibung (`tr64desc.xml` + alle SCPDs) zu laden ist teuer („a lot of communication (many slow i/o)“, fritzconnection cacht sie [D*]). Plugin: nur benötigte Services laden, cachen pro `systemVersion`. Timeout je SCPD, denn Labor-Versionen (8.24) liefern teils keine `x_speedtestSCPD.xml`, und Bibliotheken hängen sonst [D*].
- TLS verlangsamt die Box spürbar [D*]. Daher Keep-Alive, **höchstens eine** Anfrage gleichzeitig pro Box (Single-Flight-Queue), keine parallelen Collector-Läufe.
- Digest: ohne Nonce-Wiederverwendung zwei Roundtrips pro Call [?].
- Hostliste: `X_AVM-DE_GetHostListPath` braucht 1 SOAP-Call + 1 XML-Download. `GetGenericHostEntry` braucht n+1 Calls; bei ioBroker dauerte das länger als 20 s [D*]. Den Fallback daher nur selten nutzen.
- AHA: ein `getdevicelistinfos` für alle Geräte, SID wiederverwenden. Es gibt kein Push [D*]; DECT-Werte kommen ohnehin verzögert [?].
- Nach Auth-Fehlern sofort Circuit Breaker, kein Retry-Sturm, denn die BlockTime wächst [D*]. Erst nach Konfig-Änderung oder manuellem Test wieder anmelden.
- Später: Anrufmonitor (TCP-Push, fritzconnection `call_monitoring`) statt Polling der Anrufliste [D*]. Aktivierung am Telefon [?].

## Verbindungstest & Fehlercodes

Ablauf: `tr64desc.xml` → `GetSecurityPort` → TLS + Pin → `X_AVM-DE_GetCurrentUser` (Rechte → Funktionsliste) → `GetDefaultConnectionService` + WAN `GetInfo` → `X_AVM-DE_UPnP` `GetInfo` → optional AHA-Login + `getdevicelistinfos` → optional `GetCallList`.

| Fehlercode | Erkennung | Meldung an den Nutzer (DE) |
|---|---|---|
| `HOST_UNREACHABLE` | DNS, ECONNREFUSED, Timeout auf 49000 | „FRITZ!Box unter {host} nicht erreichbar.“ |
| `TR064_DISABLED` | `tr64desc.xml` fehlt oder Port 49000 zu | „TR-064 ist aus: Heimnetz › Netzwerk › Netzwerkeinstellungen › ‚Zugriff für Anwendungen zulassen‘ aktivieren.“ |
| `TLS_UNTRUSTED` / `TLS_PIN_MISMATCH` | kein Pin / SPKI geändert | „Zertifikat unbekannt bzw. geändert (die Box erzeugt es u. U. nach Neustart neu). Fingerabdruck prüfen und bestätigen.“ |
| `AUTH_FAILED` | HTTP 401 bei Digest oder `login_sid` ohne SID | „Benutzername oder Kennwort falsch. Seit FRITZ!OS 7.24 ist ein Benutzername Pflicht.“ |
| `AUTH_BLOCKED` | `BlockTime > 0` | „Die FRITZ!Box sperrt Anmeldungen nach Fehlversuchen für {n} s. Bitte warten, kein erneuter Versuch.“ |
| `RIGHT_MISSING_CONFIG` | SOAP 606 bei WAN `GetInfo` oder `BoxAdmin != readwrite` | „Dem Benutzer fehlt ‚FRITZ!Box Einstellungen‘. Internetstatus und DSL-Werte sind nicht lesbar.“ |
| `RIGHT_MISSING_PHONE` | 606 bei `GetCallList` | „Für die Anrufliste braucht der Benutzer ‚Sprachnachrichten, Faxnachrichten, FRITZ!App Fon und Anrufliste‘.“ |
| `RIGHT_MISSING_SMARTHOME` | `HomeAuto != readwrite` oder AHA 403 | „Für Smart Home braucht der Benutzer das Recht ‚Smart Home‘.“ |
| `UPNP_STATUS_DISABLED` | `X_AVM-DE_UPnP` `NewEnable = 0` | Warnung: „IPv6-Präfix und Live-Raten brauchen ‚Statusinformationen über UPnP übertragen‘.“ |
| `SERVICE_NOT_SUPPORTED` | Service fehlt in `tr64desc.xml` (z. B. DSL-Dienst bei Kabel) | Info: „{Funktion} gibt es bei dieser Box/Zugangsart nicht.“ |
| `ACTION_FAILED` | SOAP 501 / 820 | „Die FRITZ!Box hat die Aktion abgelehnt ({code}).“ |

## Eigenheiten & Stolperfallen

- **Zwei Namensräume mit gleichen Namen:** TR-064 `urn:dslforum-org:service:WANIPConnection:1` und IGD `urn:schemas-upnp-org:service:WANIPConnection:1` (`/igdupnp/control/WANIPConn1`) [D*]. IGD-Actions schreiben sich `X_AVM_DE_…` (Unterstrich), TR-064-Actions `X_AVM-DE_…` (Bindestrich) [D*]. IPv6-Adresse und -Präfix sind belastbar nur per IGD belegt [D*].
- fritzconnection reconnectet über IGD `WANIPConn1` `ForceTermination` [D*]. Home Assistant nutzt den authentifizierten TR-064-Dienst aus `Layer3Forwarding` [D*]. Das Plugin nimmt den HA-Weg (Audit, Rechteprüfung).
- **WAN-Dienst hängt vom Anschluss ab:** PPPoE (meist DSL) → `WANPPPConnection`, sonst `WANIPConnection` [D*]. `NewWANAccessType` kennt laut Adaptercode `DSL`, `Ethernet`, `X_AVM-DE_Fiber`, `X_AVMDE_UMTS` (sic), `X_AVM-DE_Cable`, `X_AVM-DE_LTE` [D*], seit 2021 auch `unknown` [S]. Eine 6660 Cable meldet `X_AVM-DE_Cable` [S].
  - **DSL:** echte Sync-, Max-, Störabstands- und CRC-Werte.
  - **Kabel/Glasfaser:** keine `WANDSLInterfaceConfig`-Werte, nur Layer1-Raten (eher Tarif-/Provisionierungsrate [?]). DOCSIS-/PON-Details nur über die undokumentierte Web-UI [?].
- **WLAN-Instanzen variieren je Modell:** typisch 1 = 2,4 GHz, 2 = 5 GHz, 3 = Gast. Boxen mit 6 GHz/Tri-Band haben eine 4. Instanz [D*]. openHAB hat `wifiGuestEnable` (fest Instanz 3) deshalb abgekündigt [D*]. Immer über `X_AVM-DE_GetWLANExtInfo` `NewX_AVM-DE_APType == guest` bestimmen [D*].
- Gast-WLAN kann einen Abschalt-Timer haben (`…TimeoutActive`/`…TimeRemain`) [D*]. Gastgeräte verschwinden beim Trennen sofort aus der Hostliste [D*].
- **DS-Lite:** keine eigene öffentliche IPv4, Portfreigaben funktionieren nicht [D*]. Die IPv4-Anzeige muss damit umgehen [?].
- **Mesh:** nur den Mesh-Master anbinden. Benutzer der Hauptbox existieren auf Repeatern nicht automatisch [D*].
- **Selbst-Aussperren:** Reconnect und Reboot unterbrechen das Internet und damit den Cloudflare-Tunnel zum Dashboard. Ist die FRITZ!Box dem UCG Ultra vorgeschaltet (siehe Offene Punkte), fällt beim Reboot das ganze Haus aus.
- **Datenschutz:** Anrufliste (Nummern, Namen) und Hostnamen sind personenbezogen. Nie loggen, SID nie in Logs (Muster: ioBroker [D*]). Anrufliste per Rolle beschränken.
- Die AHA-Oberfläche läuft auf dem Web-Port (80/443), TR-064 auf 49000/49443. Für beide gilt die Host-Allowlist, Pins getrennt prüfen.

## Wissen aus dem Altcode

Keine Altintegration. Laut ADR 0001 ist das Plugin neu [A docs/adr/0001-kickoff-decisions.md:68]; im Repo gibt es weder Client-Code noch ENV-Variablen oder Fixtures zur FRITZ!Box.

## Testbarkeit (Vertragstests)

- Kein OpenAPI. Maschinenlesbar sind die SCPD-XMLs der Box selbst (Actions, Argumente, Typen) plus AVM-PDFs je Service mit Rechteangaben [S]. Pro getesteter Firmware `tr64desc.xml`, `igddesc.xml` und die genutzten SCPDs aufzeichnen und Requests gegen die SCPD-Argumentlisten prüfen.
- Fremd-Fixtures (Lizenz prüfen): fritzconnection `fritzconnection/tests/xml/devicehostlist.xml` u. a. (MIT) [D*]; Home Assistant `tests/components/fritz/const.py` mit Mock-Antworten inkl. Rechte-XML (Apache-2.0) [D*]; pyfritzhome `tests/` mit AHA-Antworten [D*].
- Selbst aufzunehmen (anonymisiert): WAN-`GetInfo` für PPP und IP, `GetCommonLinkProperties` (DSL und Kabel), `X_AVM-DE_GetOnlineMonitor`, Hostliste, `X_AVM-DE_GetWLANExtInfo` aller Instanzen, `getdevicelistinfos`, `login_sid.lua` (Challenge, BlockTime), SOAP-Faults 606/714/501.
- PBKDF2-Login als reinen Unit-Test mit selbst erzeugten Testvektoren (`node:crypto` `pbkdf2Sync`), kein Gerät nötig.

## Aufwand & Empfehlung

- **Aufwand L:** SOAP/XML mit Digest (Node hat kein eingebautes Digest; eigene RFC-7616-Implementierung oder kleine Lib). Zwei Auth-Systeme (Digest, SID mit BlockTime). Viel Modell- und Anschlussvarianz (PPP/IP, DSL/Kabel/Glasfaser, WLAN-Instanzen). Dazu wackliges Zertifikat-Pinning, Rechte-Feature-Matrix, Datenschutz bei Anrufliste und kein Altcode.
- Abhängigkeiten: XML-Parser (z. B. `fast-xml-parser`), Digest-Auth, `node:crypto` (PBKDF2, MD5); SDK mit TLS-Pinning, Single-Flight-Queue pro Gerät und Aktionsvertrag.
- **Welle 2** (neue Plugins, nach den fünf vorhandenen). Smart Home und Anrufliste als Teilmodule hinter Feature-Flags, damit der Kern (Internet, Gast-WLAN) früher fertig wird.

## Offene Punkte

1. Rolle der FRITZ!Box im Owner-Netz: Router oder Modem/IP-Client vor dem UCG Ultra? Dazu Modell, FRITZ!OS-Version, Zugangsart (DSL/Kabel/Glasfaser). Das bestimmt Datenumfang und Aktionsrisiko.
2. Rechte für `DeviceInfo` `GetInfo`, IGD-Zugriff ohne Login und `SetSwitch`-Werte (`TOGGLE`) am Gerät prüfen; die AVM-PDFs waren nicht erreichbar.
3. Bleibt der Schlüssel (SPKI) des selbstsignierten Zertifikats nach Neustart/IP-Wechsel gleich? Davon hängt das Pinning-Konzept ab.
4. Ergibt `X_AVM-DE_AppSetup` `RegisterApp` mit `RO`-Rechten eine nutzbare Read-only-Identität?
5. SID-Timeout (20 min [S]) und Digest-Nonce-Wiederverwendung am Gerät messen.
6. Smart Home: AHA-HTTP behalten oder ab FRITZ!OS 8.2 die neue REST-API nutzen [S]?
7. Semantik von `Hosts` `X_AVM-DE_GetChangeCounter` (zum Überspringen unveränderter Hostlisten).

## Quellen

1. https://github.com/kbr/fritzconnection [D*]: `docs/sources/getting_started.rst` (49000, `use_tls`, selbstsigniert, Username ab 7.24, Settings-Namen, Cache), `fritzconnection/core/fritzconnection.py` (49000/49443, `igddesc.xml`+`tr64desc.xml`, `reconnect`/`reboot`), `core/soaper.py` (SOAP-Header, Digest, Fehlerparsing), `core/exceptions.py` (Fehlercodes), `core/fritzhttp.py` (login_sid v2, PBKDF2/MD5, 403-Retry), `lib/fritzstatus.py`, `lib/fritzhosts.py`, `lib/fritzwlan.py`, `lib/fritzcall.py`, `lib/fritzhomeauto.py`, `tests/xml/devicehostlist.xml`.
2. https://github.com/home-assistant/core (`homeassistant/components/fritz/const.py`, `coordinator.py`, `config_flow.py`, `sensor.py`; `tests/components/fritz/const.py`) [D*]: Ports, 30 s Intervall, UPnP-Prüfung, Rechte-XML, Reconnect über `Layer3Forwarding`-Dienst, `DisconnectInProgress`.
3. https://github.com/home-assistant/home-assistant.io (`source/_integrations/fritz.markdown`, `fritzbox.markdown`) [D*]: TR-064 + UPnP aktivieren, Rechte „FRITZ!Box Settings“ bzw. „Smart Home“, Mesh-, Gast- und DS-Lite-Hinweise, 30 s Polling.
4. https://github.com/hthiery/python-fritzhome (`pyfritzhome/fritzhome.py`, `devicetypes/*`) [D*]: AHA-Login, BlockTime, `switchcmd`-Liste, Thermostat- und Schalter-XML, REST-Probe `rest_api_desc.json`.
5. https://github.com/openhab/openhab-addons (`bundles/org.openhab.binding.tr064/src/main/resources/channels.xml`) [D*]: Service-IDs, Actions, Argumente und Einheiten (DSL, OnlineMonitor, WLAN 1–4, Reboot, CallList, SecurityPort).
6. https://github.com/Lucky-ESA/ioBroker.fritzboxdect (`lib/tr-064.js`) [D*]: Rechte-Tabelle je Action (C/A/P/N/H). https://github.com/afuerhoff/ioBroker.fb-checkpresence (README, `lib/fb.js`) [D*]: HostListPath seit 09.01.2017, Benutzerpflicht ab 7.25, WAN-Zugangsarten. https://github.com/iobroker-community-adapters/ioBroker.tr-064 (`CHANGELOG_OLD.md`, `src/lib/tr064.ts`) [D*]: GetGenericHostEntry > 20 s, SCPD-Timeout bei 8.24 Labor, Log-Redaktion.
7. Gast-WLAN über `NewX_AVM-DE_APType`: https://github.com/Azd325/router-axi (README, verweist auf AVM „WLANConfiguration v49“), https://github.com/jhubig/FritzBoxShell, https://github.com/Nall-chan/FritzBox, https://github.com/not-na/fritzctl [D*].
8. IGD-IPv6-Actions: https://github.com/cromefire/fritzbox-cloudflare-dyndns, https://github.com/blacksenator/fritzsoap (`src/WANIPConn1_1.php`, `src/x_appsetup.php`, `src/lanconfigsecurity.php`) [D*].
9. https://fritz.com/fileadmin/user_upload/Global/Service/Schnittstellen/AVM_TR-064_first_steps.pdf [S]: Rechteklassen C/A/P/N/H, 401 vs. 606, Default C, `ForceTermination` C, `GetCallList` P.
10. https://fritz.com/fileadmin/user_upload/Global/Service/Schnittstellen/AVM_Technical_Note_-_Session_ID_deutsch_2021-05-03.pdf [S]: `login_sid.lua?version=2`, PBKDF2 ab 7.24, MD5 ab 5.50, BlockTime.
11. https://service.avm.de/help/en/FRITZ-Box-7590/015/hilfe_system_userkonto und PC-Welt [S]: Benutzerrechte in der Oberfläche, 20 min Session-Timeout, automatisches Mitsetzen der Rechte.
12. https://fritz.com/pages/schnittstellen [S]: TR-064 nur im LAN. Forenthreads deskmodder.de / mobiflip.de [S]: Zertifikat nach Neustart neu, Let's Encrypt nur für MyFRITZ. ip-phone-forum.de [S]: `X_AVM-DE_Cable`. docs.evcc.io [S]: REST-API ab FRITZ!OS 8.2.
