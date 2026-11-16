export interface ListenConfig {
  host: string;
  port: number;
}

/** Reads the listen address from the environment. Defaults keep the server off the network. */
export function readListenConfig(env: NodeJS.ProcessEnv): ListenConfig {
  const host = env.HOST ?? '127.0.0.1';
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }
  return { host, port };
}
