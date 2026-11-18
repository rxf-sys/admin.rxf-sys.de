import { type CoreCatalog, coreDe, createTranslator } from '@rxf/i18n';

const LOCALE = 'de-DE';

/** German is the only UI language until the language setting arrives (roadmap). */
export const t = createTranslator(coreDe, LOCALE);

export type MessageKey = keyof CoreCatalog & string;

export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(coreDe, key);
}

const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(ms: number): string {
  return dateTime.format(ms);
}
