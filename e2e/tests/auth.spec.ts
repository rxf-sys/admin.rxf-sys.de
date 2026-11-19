import { expect } from '@playwright/test';
import { credentials, expectAccessible, saveCredentials, shoot, signIn, takeBackupCode, test } from './support.ts';

test('the login screen is accessible and reports wrong credentials', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anmelden');
  await expectAccessible(page);
  await shoot(page, 'login', testInfo);

  await page.getByLabel('Benutzername').fill(credentials().username);
  await page.getByLabel('Passwort', { exact: true }).fill('not the password at all');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Benutzername oder Passwort stimmt nicht.');
  await expect(page.getByLabel('Benutzername')).toHaveAttribute('aria-invalid', 'true');
});

test('the skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/login');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Zum Inhalt springen' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});

test('sign-in with the second factor opens the overview', async ({ page }, testInfo) => {
  await signIn(page);
  // The uptime instance from the setup project shows up as a widget with its check.
  await expect(page.getByText('Dashboard-API')).toBeVisible();
  await expect(page.getByText('1 von 1 erreichbar')).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'dashboard', testInfo);
});

test('security: session list and new backup codes behind a re-authentication', async ({ page }, testInfo) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Sicherheit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sicherheit' })).toBeVisible();
  await expect(page.getByText('Dieses Gerät')).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'security', testInfo);

  await page.getByRole('button', { name: 'Neue Backup-Codes erzeugen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Identität bestätigen' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'reauth', testInfo);

  // A wrong password keeps the dialog open with a message.
  await dialog.getByLabel('Passwort', { exact: true }).fill('wrong password, sorry');
  await dialog.getByLabel('Code aus der App oder Backup-Code').fill('000000');
  await dialog.getByRole('button', { name: 'Bestätigen', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Passwort oder Code stimmt nicht.');

  await dialog.getByLabel('Passwort', { exact: true }).fill(credentials().password);
  await dialog.getByLabel('Code aus der App oder Backup-Code').fill(takeBackupCode());
  await dialog.getByRole('button', { name: 'Bestätigen', exact: true }).click();
  await expect(dialog).toBeHidden();

  const list = page.getByRole('list', { name: 'Backup-Codes' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  // The old codes are void now; later logins use the new ones.
  saveCredentials({ ...credentials(), backupCodes: await list.getByRole('listitem').allInnerTexts() });
});

test('signing out returns to the login and ends the session', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/settings/security');
  await expect(page).toHaveURL(/\/login$/);
});

test('passkeys: add one behind a re-authentication, then sign in with it alone', async ({ page }, testInfo) => {
  // Chromium's virtual authenticator: discoverable credentials with user verification.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signIn(page);
  await page.getByRole('link', { name: 'Sicherheit' }).click();
  const name = `E2E ${testInfo.project.name}`;
  await page.getByLabel('Name des neuen Passkeys').fill(name);
  await page.getByRole('button', { name: 'Passkey hinzufügen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Identität bestätigen' });
  await dialog.getByLabel('Passwort', { exact: true }).fill(credentials().password);
  await dialog.getByLabel('Code aus der App oder Backup-Code').fill(takeBackupCode());
  await dialog.getByRole('button', { name: 'Bestätigen', exact: true }).click();
  await expect(page.getByText(name)).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'security-passkeys', testInfo);

  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Übersicht' })).toBeVisible();
});
