import { createTranslator, type Translation } from '@rxf/i18n';
import type { Locale } from '@rxf/web-sdk';

/** Catalog of the uptime web part, German first like the core (packages/i18n). */
const de = {
  'widget.summary': '{up} von {total} erreichbar',
  'widget.empty': 'Noch keine Messwerte. Die erste Prüfung läuft gleich.',
  'widget.loading': 'Wird geladen …',
  'widget.error': 'Die Prüfungen konnten nicht geladen werden.',
  'widget.responseTime': '{ms} ms',
  'widget.noResponse': 'keine Antwort',
  'widget.sparkline': 'Antwortzeit der letzten 24 Stunden: {min} bis {max} ms',
  'widget.sparklineEmpty': 'Noch keine Antwortzeiten der letzten 24 Stunden',
  'status.ok': 'Erreichbar',
  'status.warn': 'Langsam',
  'status.crit': 'Gestört',
  'status.unknown': 'Unbekannt',
  'status.paused': 'Pausiert',
  'form.checks': 'Prüfungen',
  'form.checksHelp': 'Jede Prüfung ruft eine URL ab und wertet Statuscode und Antwortzeit aus.',
  'form.check': 'Prüfung {n}',
  'form.name': 'Name',
  'form.url': 'URL',
  'form.method': 'Methode',
  'form.expected': 'Erwartete Statuscodes',
  'form.expectedHelp': 'Leer lassen für 200–399, 401, 403, 405.',
  'form.remove': 'Prüfung {n} entfernen',
  'form.add': 'Prüfung hinzufügen',
  'form.slow': 'Langsam ab (ms)',
  'form.allowBlocked': 'Prüfungen gegen diesen Host erlauben (Loopback)',
  'form.allowBlockedHelp': 'Nur nötig, wenn eine URL auf den Dashboard-Host selbst zeigt.',
  'form.errorName': 'Jede Prüfung braucht einen eigenen Namen.',
  'form.errorUrl': 'Die URL muss mit http:// oder https:// beginnen.',
  'form.errorExpected': 'Format: 200 oder 200-299, mehrere mit Komma.',
  'form.errorNone': 'Lege mindestens eine Prüfung an.',
} as const;

const en: Translation<typeof de> = {
  'widget.summary': '{up} of {total} reachable',
  'widget.empty': 'No measurements yet. The first check runs shortly.',
  'widget.loading': 'Loading …',
  'widget.error': 'The checks could not be loaded.',
  'widget.responseTime': '{ms} ms',
  'widget.noResponse': 'no response',
  'widget.sparkline': 'Response time over the last 24 hours: {min} to {max} ms',
  'widget.sparklineEmpty': 'No response times in the last 24 hours yet',
  'status.ok': 'Reachable',
  'status.warn': 'Slow',
  'status.crit': 'Failing',
  'status.unknown': 'Unknown',
  'status.paused': 'Paused',
  'form.checks': 'Checks',
  'form.checksHelp': 'Each check fetches one URL and evaluates status code and response time.',
  'form.check': 'Check {n}',
  'form.name': 'Name',
  'form.url': 'URL',
  'form.method': 'Method',
  'form.expected': 'Expected status codes',
  'form.expectedHelp': 'Leave empty for 200–399, 401, 403, 405.',
  'form.remove': 'Remove check {n}',
  'form.add': 'Add check',
  'form.slow': 'Slow from (ms)',
  'form.allowBlocked': 'Allow checks against this host (loopback)',
  'form.allowBlockedHelp': 'Only needed when a URL points at the dashboard host itself.',
  'form.errorName': 'Every check needs a name of its own.',
  'form.errorUrl': 'The URL must start with http:// or https://.',
  'form.errorExpected': 'Format: 200 or 200-299, several separated by commas.',
  'form.errorNone': 'Add at least one check.',
};

const translators = { de: createTranslator(de, 'de-DE'), en: createTranslator(en, 'en-GB') };

export function translator(locale: Locale) {
  return translators[locale];
}
