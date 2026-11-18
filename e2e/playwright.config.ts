import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const API_PORT = 3100;
// Every run starts from an empty data directory with a throwaway master key. Workers load this file
// again, so the directory is created once and handed down through the environment.
process.env.RXF_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'rxf-e2e-'));
const DATA_DIR = process.env.RXF_E2E_DATA_DIR;
const MASTER_KEY = randomBytes(32).toString('base64');
const WEB_PORT = 4173;

// Containers with a preinstalled Chromium (cloud sessions) point Playwright at it instead of downloading.
const executablePath = process.env.PW_CHROMIUM_PATH;

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
const phone = { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } };

export default defineConfig({
  testDir: 'tests',
  outputDir: 'test-results',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One account for all projects: logins share its backup codes, so tests run one after another.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    // Creates the admin through the real first-start flow and records its credentials for the others.
    { name: 'setup', testMatch: 'setup.spec.ts', use: { ...desktop, colorScheme: 'dark' } },
    ...(
      [
        ['desktop-dark', desktop, 'dark'],
        ['desktop-light', desktop, 'light'],
        ['phone-dark', phone, 'dark'],
        ['phone-light', phone, 'light'],
      ] as const
    ).map(([name, device, colorScheme]) => ({
      name,
      testIgnore: 'setup.spec.ts',
      dependencies: ['setup'],
      use: { ...device, colorScheme },
    })),
  ],
  webServer: [
    {
      // The log is kept so the setup test can read the setup code, the only place it appears (ADR 0005).
      command: `node --conditions=@rxf/source ../apps/server/src/main.ts 2>&1 | tee ${join(DATA_DIR, 'server.log')}`,
      env: { PORT: String(API_PORT), RXF_VERSION: 'e2e', RXF_DATA_DIR: DATA_DIR, RXF_MASTER_KEY: MASTER_KEY },
      url: `http://127.0.0.1:${API_PORT}/api/healthz`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // An explicit IPv4 host: on CI runners "localhost" resolves to ::1 first, where Playwright never looks.
      command: `pnpm --filter @rxf/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: { RXF_API_URL: `http://127.0.0.1:${API_PORT}` },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
