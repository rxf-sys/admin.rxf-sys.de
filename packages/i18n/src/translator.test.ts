import { describe, expect, it } from 'vitest';
import { coreDe } from './core.de.ts';
import { coreEn } from './core.en.ts';
import { createTranslator } from './translator.ts';

const catalog = { greeting: 'Hallo {name}', count: '{n} Gäste', plain: 'Ohne Platzhalter' } as const;

describe('createTranslator', () => {
  const t = createTranslator(catalog, 'de-DE');

  it('returns the template when there are no params', () => {
    expect(t('plain')).toBe('Ohne Platzhalter');
  });

  it('fills string placeholders', () => {
    expect(t('greeting', { name: 'Đặng Thị' })).toBe('Hallo Đặng Thị');
  });

  it('formats numbers for the locale', () => {
    expect(t('count', { n: 1284 })).toBe('1.284 Gäste');
    expect(createTranslator(catalog, 'en-US')('count', { n: 1284 })).toBe('1,284 Gäste');
  });

  it('keeps a placeholder visible when its param is missing', () => {
    expect(t('greeting', {})).toBe('Hallo {name}');
  });
});

describe('core catalogs', () => {
  it('English implements every German key', () => {
    expect(Object.keys(coreEn).sort()).toEqual(Object.keys(coreDe).sort());
  });
});
