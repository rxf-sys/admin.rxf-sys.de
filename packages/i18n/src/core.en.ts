import type { CoreCatalog } from './core.de.ts';
import type { Translation } from './translator.ts';

export const coreEn: Translation<CoreCatalog> = {
  'app.name': 'rxf-sys Control',
  'app.skipToContent': 'Skip to content',
  'health.title': 'Server',
  'health.checking': 'Checking connection …',
  'health.ok': 'Reachable, version {version}',
  'health.error': 'Not reachable. Is the server container running?',
};
