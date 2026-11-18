import { expect, test } from '@playwright/test';
import { expectAccessible, saveCredentials, serverLog, shootAllVariants, totp } from './support.ts';

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
  await expect(page.getByRole('status').filter({ hasText: 'Erreichbar' })).toHaveText('Erreichbar, Version e2e');

  // Setup is closed for good: signing out leads to the login, not back to setup.
  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
