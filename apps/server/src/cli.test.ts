import { describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';

function run(args: string[]) {
  const lines: string[] = [];
  const code = runCli(args, (line) => lines.push(line));
  return { code, lines };
}

describe('rxf cli', () => {
  it('keygen prints one new 32-byte key', () => {
    const { code, lines } = run(['keygen']);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Buffer.from(lines[0] ?? '', 'base64')).toHaveLength(32);
  });

  it('prints usage for help and no arguments', () => {
    expect(run([])).toMatchObject({ code: 0, lines: [expect.stringMatching(/^usage: rxf keygen/)] });
    expect(run(['help']).code).toBe(0);
  });

  it('fails on unknown commands and extra arguments', () => {
    expect(run(['rotate']).code).toBe(2);
    expect(run(['keygen', '--force']).code).toBe(2);
  });
});
