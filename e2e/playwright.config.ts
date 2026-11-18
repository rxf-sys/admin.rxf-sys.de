import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const API_PORT = 3100;
// Every run starts from an empty data directory with a throwaway master key.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'rxf-e2e-'));
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
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'phone-dark', use: { ...phone, colorScheme: 'dark' } },
    { name: 'phone-light', use: { ...phone, colorScheme: 'light' } },
  ],
  webServer: [
    {
      command: 'node --conditions=@rxf/source ../apps/server/src/main.ts',
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
