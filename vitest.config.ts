import { defineConfig } from 'vitest/config';

const sourceConditions = ['@rxf/source'];

export default defineConfig({
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    projects: [
      { extends: true, test: { name: 'contracts', root: 'packages/contracts', environment: 'node' } },
      { extends: true, test: { name: 'i18n', root: 'packages/i18n', environment: 'node' } },
      { extends: true, test: { name: 'sdk', root: 'packages/sdk', environment: 'node' } },
      { extends: true, test: { name: 'server', root: 'apps/server', environment: 'node' } },
      { extends: true, test: { name: 'web', root: 'apps/web', environment: 'jsdom' } },
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**'],
      // Entry points only wire modules together; their behaviour is covered by the e2e suite.
      exclude: ['**/*.test.{ts,tsx}', 'apps/server/src/main.ts', 'apps/web/src/main.tsx'],
      // ADR 0009: core ≥ 80 %. Plugins get their own ≥ 70 % gate when the first one lands.
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
