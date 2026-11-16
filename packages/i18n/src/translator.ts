/** A message catalog: message key → template. Placeholders are written as `{name}`. */
export type Catalog = Readonly<Record<string, string>>;

/** Another locale for a catalog: exactly the same keys, so a missing translation fails to compile. */
export type Translation<C extends Catalog> = { readonly [K in keyof C]: string };

export type MessageParams = Readonly<Record<string, string | number>>;

export type Translate<C extends Catalog> = (key: keyof C & string, params?: MessageParams) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Returns `t(key, params)` for one locale. Numbers in params are formatted for that locale;
 * a placeholder without a matching param stays visible so the gap shows up in review.
 */
export function createTranslator<C extends Catalog>(catalog: Translation<C>, locale: string): Translate<C> {
  const numbers = new Intl.NumberFormat(locale);
  return (key, params) => {
    const template = catalog[key];
    if (!params) return template;
    return template.replace(PLACEHOLDER, (placeholder, name: string) => {
      const value = params[name];
      if (value === undefined) return placeholder;
      return typeof value === 'number' ? numbers.format(value) : value;
    });
  };
}
