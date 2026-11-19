import { expect, test } from '@playwright/test';
import {
  credentials,
  expectAccessible,
  saveCredentials,
  serverLog,
  shootAllVariants,
  signIn,
  takeBackupCode,
  totp,
} from './support.ts';

const API_PORT = 3100;

const USERNAME = 'robin';
const PASSWORD = 'correct horse battery staple';

test('first start: setup code from the log, admin account, second factor, backup codes', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ersteinrichtung');
  await expectAccessible(page);
  await shootAllVariants(page, 'setup');

  // A wrong code is refused with a message instead of a dead end.
  await page.getByLabel('Setup-Code').fill('AAAAA-AAAAA-AAAAA-AAAAA');
  await page.getByLabel('Benutzername für das Admin-Konto').fill(USERNAME);
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Admin-Konto anlegen' }).click();
  await expect(page.getByRole('alert')).toContainText('Setup-Code stimmt nicht');

  const codes = [...serverLog().matchAll(/Setup code \(valid 24 h, replaced on restart\): ([A-Z0-9-]+)/g)];
  const setupCode = codes.at(-1)?.[1];
  expect(setupCode).toBeTruthy();
  await page.getByLabel('Setup-Code').fill(setupCode as string);
  await page.getByRole('button', { name: 'Admin-Konto anlegen' }).click();

  await expect(page).toHaveURL(/\/enrol$/);
  const secretBox = page.locator('code');
  await expect(secretBox).toHaveText(/[A-Z2-7 ]{16,}/);
  await expectAccessible(page);
  await shootAllVariants(page, 'enrol');
  const totpSecret = (await secretBox.innerText()).replaceAll(' ', '');
  await page.getByLabel('Code aus der App').fill(totp(totpSecret));
  await page.getByRole('button', { name: 'Einrichten' }).click();

  const list = page.getByRole('list', { name: 'Backup-Codes' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  const backupCodes = await list.getByRole('listitem').allInnerTexts();
  saveCredentials({ username: USERNAME, password: PASSWORD, totpSecret, backupCodes });
  await expectAccessible(page);
  await shootAllVariants(page, 'backup-codes');

  await page.getByRole('button', { name: 'Codes gesichert, weiter' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Übersicht' })).toBeVisible();

  // Setup is closed for good: signing out leads to the login, not back to setup.
  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('onboarding: uptime check against the server itself; an empty board loads no plugin code', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
  });
  await signIn(page);
  await expect(page.getByText('Lege die erste Integration an')).toBeVisible();
  // An empty board loads no plugin code at all (ADR 0003, runtime half of the isolation proof).
  expect(scripts.filter((path) => path.includes('/plugin-'))).toEqual([]);

  await page.getByRole('link', { name: 'Integration hinzufügen' }).click();
  await expect(page.getByText('Schritt 1 von 3')).toBeVisible();
  await expectAccessible(page);
  await shootAllVariants(page, 'onboarding-catalog');
  await page.getByRole('button', { name: 'Uptime auswählen' }).click();

  await page.getByLabel('Name', { exact: true }).fill('Dashboard-API');
  await page.getByLabel('URL', { exact: true }).fill(`http://127.0.0.1:${API_PORT}/api/healthz`);
  await page.getByLabel(/Prüfungen gegen diesen Host erlauben/).check();
  await expectAccessible(page);
  await shootAllVariants(page, 'onboarding-connect');
  await page.getByRole('button', { name: 'Speichern und prüfen' }).click();

  // Creating an instance brings targets: the re-authentication dialog asks first (ADR 0005).
  const dialog = page.getByRole('dialog', { name: 'Identität bestätigen' });
  await dialog.getByLabel('Passwort', { exact: true }).fill(credentials().password);
  await dialog.getByLabel('Code aus der App oder Backup-Code').fill(takeBackupCode());
  await dialog.getByRole('button', { name: 'Bestätigen' }).click();

  await expect(page.getByText('Die Verbindung passt.')).toBeVisible();
  await expectAccessible(page);
  await shootAllVariants(page, 'onboarding-test');
  await page.getByRole('button', { name: 'Aktivieren' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Übersicht' })).toBeVisible();
  await expect(page.getByText('1 von 1 erreichbar')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Dashboard-API')).toBeVisible();
  const pluginScripts = scripts.filter((path) => path.includes('/plugin-'));
  expect(pluginScripts.length).toBeGreaterThan(0);
  expect(pluginScripts.every((path) => path.includes('/plugin-uptime-'))).toBe(true);
});
