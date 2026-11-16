import { generateMasterKey } from './crypto/master-key.ts';

const USAGE = 'usage: rxf keygen    print a new master key (32 random bytes, base64) for RXF_MASTER_KEY_FILE';

/** Container-side admin commands (ADR 0006). Returns the process exit code. */
export function runCli(args: readonly string[], out: (line: string) => void): number {
  const [command] = args;
  if (command === 'keygen' && args.length === 1) {
    out(generateMasterKey());
    return 0;
  }
  out(USAGE);
  return command === undefined || command === 'help' ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`));
}
