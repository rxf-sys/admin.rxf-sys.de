import { describe, expect, it } from 'vitest';
import { readListenConfig } from './config.ts';

describe('readListenConfig', () => {
  it('defaults to loopback on port 3000', () => {
    expect(readListenConfig({})).toEqual({ host: '127.0.0.1', port: 3000 });
  });

  it('reads HOST and PORT', () => {
    expect(readListenConfig({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it.each(['', 'abc', '0', '65536', '80.5'])('rejects PORT=%j', (port) => {
    expect(() => readListenConfig({ PORT: port })).toThrow(/PORT must be an integer/);
  });
});
