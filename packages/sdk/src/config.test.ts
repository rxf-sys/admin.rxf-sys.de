import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { adminOnlyFieldNames, defineConfig, field, secretFieldNames } from './config.ts';
import { pluginManifest } from './manifest.ts';
import { originOf } from './targets.ts';

const label = { de: 'Feld', en: 'Field' };

describe('defineConfig', () => {
  const config = defineConfig({
    host: field(z.string(), { label, adminOnly: true }),
    token: field(z.string(), { label, secret: true }),
    intervalS: field(z.number(), { label }),
  });

  it('builds the object schema from the fields', () => {
    expect(config.schema.safeParse({ host: 'pve', token: 't', intervalS: 30 }).success).toBe(true);
    expect(config.schema.safeParse({ host: 'pve', intervalS: 30 }).success).toBe(false);
  });

  it('names secret and admin-only fields', () => {
    expect(secretFieldNames(config)).toEqual(['token']);
    expect(adminOnlyFieldNames(config)).toEqual(['host']);
  });
});

describe('pluginManifest', () => {
  const manifest = {
    id: 'uptime',
    name: { de: 'Uptime', en: 'Uptime' },
    description: { de: 'Prüfungen', en: 'Checks' },
    version: '0.1.0',
    core: '^2.0.0',
    icon: 'activity',
    category: 'monitoring',
    multiInstance: false,
  };

  it('accepts a valid manifest', () => {
    expect(pluginManifest.safeParse(manifest).success).toBe(true);
  });

  it.each(['Uptime', 'up time', '-uptime', 'uptime_'])('rejects the id %j', (id) => {
    expect(pluginManifest.safeParse({ ...manifest, id }).success).toBe(false);
  });
});

describe('originOf', () => {
  it.each([
    ['https://PVE.local:8006/api2/json', 'https://pve.local:8006'],
    ['https://example.org/x', 'https://example.org:443'],
    ['http://192.168.2.1', 'http://192.168.2.1:80'],
    ['http://[fd00::1]:8080/', 'http://[fd00::1]:8080'],
  ])('normalises %s', (url, origin) => {
    expect(originOf(url)).toBe(origin);
  });

  it('rejects other schemes', () => {
    expect(() => originOf('ftp://host/x')).toThrow(/unsupported scheme/);
  });
});
