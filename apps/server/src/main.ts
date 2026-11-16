import { buildApp } from './app.ts';
import { readListenConfig } from './config.ts';

const { host, port } = readListenConfig(process.env);
const app = buildApp({ version: process.env.RXF_VERSION ?? 'dev', logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}

await app.listen({ host, port });
