/** Core catalog, German. German is the source locale: every other locale implements these keys. */
export const coreDe = {
  'app.name': 'rxf-sys Control',
  'app.skipToContent': 'Zum Inhalt springen',
  'health.title': 'Server',
  'health.checking': 'Verbindung wird geprüft …',
  'health.ok': 'Erreichbar, Version {version}',
  'health.error': 'Nicht erreichbar. Läuft der Server-Container?',
} as const;

export type CoreCatalog = typeof coreDe;
