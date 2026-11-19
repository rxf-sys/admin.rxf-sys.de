import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import * as OTPAuth from 'otpauth';

const DATA_DIR = process.env.RXF_E2E_DATA_DIR as string;
const CREDENTIALS = join(DATA_DIR, 'credentials.json');

/**
 * `test` with a page that fails the test on any CSP or Trusted Types violation: preview serves the
 * production headers (apps/web/security-headers.ts), so this is the CSP check of ADR 0008.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Trusted Type/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', (error) => violations.push(`uncaught: ${error.message}`));
    await use(page);
    expect(violations).toEqual([]);
  },
});

export interface Credentials {
  username: string;
  password: string;
  totpSecret: string;
  /** Unused backup codes; every login takes one, because a TOTP code may only be used once (replay guard). */
  backupCodes: string[];
}

export function serverLog(): string {
  return readFileSync(join(DATA_DIR, 'server.log'), 'utf8');
}

export function saveCredentials(credentials: Credentials): void {
  writeFileSync(CREDENTIALS, JSON.stringify(credentials));
}

export function credentials(): Credentials {
  return JSON.parse(readFileSync(CREDENTIALS, 'utf8')) as Credentials;
}

export function takeBackupCode(): string {
  const current = credentials();
  const code = current.backupCodes.shift();
  if (!code) throw new Error('no backup codes left for e2e logins');
  saveCredentials(current);
  return code;
}

export function totp(secret: string): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

export async function expectAccessible(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

export async function shoot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await page.screenshot({ path: `screenshots/${name}-${testInfo.project.name}.png`, fullPage: true });
}

/** The four review variants (1440/390 px, light/dark) within one test, for screens that exist only once. */
export async function shootAllVariants(page: Page, name: string): Promise<void> {
  for (const [label, width, height] of [
    ['desktop', 1440, 900],
    ['phone', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `screenshots/${name}-${label}-${scheme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
}

export async function signIn(page: Page): Promise<void> {
  const { username, password } = credentials();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/login\/verify$/);
  await page.getByRole('button', { name: 'Backup-Code verwenden' }).click();
  await page.getByLabel('Backup-Code').fill(takeBackupCode());
  await page.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Übersicht' })).toBeVisible();
}
