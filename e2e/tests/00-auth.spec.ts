import { alertText, expect, test } from '../support/fixtures';
import { PASSWORD } from '../support/db';

/**
 * Login gets its own spec. Every other spec plants a refresh cookie and lets the app
 * silently mint a token — so if the sign-in FORM broke, nothing else here would notice.
 */
test.describe('authentication', () => {
  test('signs in and lands on the dashboard', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill('frontdesk@hotelos.dev');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    await expect(page.getByText('Welcome back')).toBeVisible();
  });

  test('rejects a wrong password without revealing whether the account exists', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('frontdesk@hotelos.dev');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const wrongPassword = alertText(page);
    await expect(wrongPassword).toBeVisible();
    const messageA = await wrongPassword.textContent();

    // An unknown account must produce the SAME message. A different one turns the
    // login form into an account-enumeration oracle.
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@hotelos.dev');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const unknownUser = alertText(page);
    await expect(unknownUser).toBeVisible();

    expect(await unknownUser.textContent()).toBe(messageA);
  });

  test('an unauthenticated visitor is sent to login', async ({ page }) => {
    await page.goto('/front-desk');
    await page.waitForURL('**/login', { timeout: 30_000 });
  });

  /**
   * The access token lives in memory only, so a reload wipes it. The httpOnly refresh
   * cookie survives and silently mints a new one — which is why a reload must NOT
   * look like a logout.
   */
  test('a page reload does not sign the user out', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('manager@hotelos.dev');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/dashboard', { timeout: 30_000 });

    await page.reload();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('Welcome back')).toBeVisible({ timeout: 20_000 });
  });
});
