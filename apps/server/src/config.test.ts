import { describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from './config.ts';

describe('readConfig', () => {
  it('uses safe defaults', () => {
    expect(readConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      version: 'dev',
      production: false,
      dataDir: '/data',
      masterKeyFile: '/run/secrets/rxf_master_key',
      masterKeyInline: undefined,
      trustedProxies: [],
      publicOrigin: 'http://localhost:5173',
    });
  });

  it('reads every variable', () => {
    const config = readConfig({
      HOST: '0.0.0.0',
      PORT: '8080',
      RXF_VERSION: '2.0.0',
      NODE_ENV: 'production',
      RXF_DATA_DIR: '/srv/data',
      RXF_MASTER_KEY_FILE: '/srv/key',
      RXF_PUBLIC_ORIGIN: 'https://admin.rxf-sys.de',
    });
    expect(config).toMatchObject({ host: '0.0.0.0', port: 8080, version: '2.0.0', production: true });
    expect(config).toMatchObject({ dataDir: '/srv/data', masterKeyFile: '/srv/key' });
    expect(config.publicOrigin).toBe('https://admin.rxf-sys.de');
  });

  it('requires an https public origin in production and accepts http only for localhost', () => {
    expect(() => readConfig({ NODE_ENV: 'production' })).toThrow(/RXF_PUBLIC_ORIGIN is required/);
    expect(readConfig({ RXF_PUBLIC_ORIGIN: 'https://admin.rxf-sys.de/' }).publicOrigin).toBe(
      'https://admin.rxf-sys.de',
    );
    expect(readConfig({ RXF_PUBLIC_ORIGIN: 'http://localhost:4173' }).publicOrigin).toBe('http://localhost:4173');
    for (const bad of [
      'http://admin.rxf-sys.de',
      'https://admin.rxf-sys.de/app',
      'admin.rxf-sys.de',
      'http://127.0.0.1',
    ]) {
      expect(() => readConfig({ RXF_PUBLIC_ORIGIN: bad })).toThrow(ConfigError);
    }
  });

  it.each(['', ' ', 'abc', '0', '65536', '80.5'])('rejects PORT=%j', (port) => {
    expect(() => readConfig({ PORT: port })).toThrow(ConfigError);
  });

  it('reads trusted proxies as addresses and CIDRs', () => {
    expect(readConfig({ RXF_TRUSTED_PROXIES: '172.20.0.10, 10.0.0.0/8 ,fd00::/64' }).trustedProxies).toEqual([
      '172.20.0.10',
      '10.0.0.0/8',
      'fd00::/64',
    ]);
  });

  it.each(['caddy', '10.0.0.0/33', '300.1.1.1', '10.0.0.1/abc'])('rejects RXF_TRUSTED_PROXIES=%j', (value) => {
    expect(() => readConfig({ RXF_TRUSTED_PROXIES: value })).toThrow(/RXF_TRUSTED_PROXIES/);
  });

  it('accepts an inline master key outside production', () => {
    expect(readConfig({ RXF_MASTER_KEY: 'abc' }).masterKeyInline).toBe('abc');
  });

  it('refuses an inline master key in production', () => {
    expect(() => readConfig({ NODE_ENV: 'production', RXF_MASTER_KEY: 'abc' })).toThrow(/development only/);
  });
});
