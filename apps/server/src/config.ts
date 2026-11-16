export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  host: string;
  port: number;
  version: string;
  production: boolean;
  /** Directory for the database and pre-migration backups (Docker volume in production). */
  dataDir: string;
  masterKeyFile: string;
  /** Inline master key, development only (ADR 0006). */
  masterKeyInline: string | undefined;
}

/** Reads the server configuration from the environment. Defaults keep the server off the network. */
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (rawPort.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }
  const production = env.NODE_ENV === 'production';
  const masterKeyInline = env.RXF_MASTER_KEY || undefined;
  if (production && masterKeyInline) {
    throw new ConfigError('RXF_MASTER_KEY is for development only; mount the key file in production (ADR 0006)');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    version: env.RXF_VERSION ?? 'dev',
    production,
    dataDir: env.RXF_DATA_DIR ?? '/data',
    masterKeyFile: env.RXF_MASTER_KEY_FILE ?? '/run/secrets/rxf_master_key',
    masterKeyInline,
  };
}
