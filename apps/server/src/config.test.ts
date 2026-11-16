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
    });
    expect(config).toMatchObject({ host: '0.0.0.0', port: 8080, version: '2.0.0', production: true });
    expect(config).toMatchObject({ dataDir: '/srv/data', masterKeyFile: '/srv/key' });
  });

  it.each(['', ' ', 'abc', '0', '65536', '80.5'])('rejects PORT=%j', (port) => {
    expect(() => readConfig({ PORT: port })).toThrow(ConfigError);
  });

  it('accepts an inline master key outside production', () => {
    expect(readConfig({ RXF_MASTER_KEY: 'abc' }).masterKeyInline).toBe('abc');
  });

  it('refuses an inline master key in production', () => {
    expect(() => readConfig({ NODE_ENV: 'production', RXF_MASTER_KEY: 'abc' })).toThrow(/development only/);
  });
});
