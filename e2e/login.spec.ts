import { test, expect } from '@playwright/test';
import { signIn } from './helpers/auth';
import { getTestCredentials } from './helpers/credentials';

// These specs exercise the real NextAuth credentials flow against the target
// environment (local / staging / production, selected by `TEST_ENV`). No
// session or sign-in mocking — a fresh context starts unauthenticated, and a
// real sign-in sets a real session cookie.

test.describe('Login page', () => {
  test('Unauthenticated user opens the login page', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'BRAIN 2.0' })).toBeVisible();
    await expect(page.locator('#signin-email')).toBeVisible();
    await expect(page.locator('#signin-password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('User submits a wrong email/password combination', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await page.locator('#signin-email').fill('wrong@example.com');
    await page.locator('#signin-password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // The real backend rejects the credentials; the form surfaces the error in a
    // destructive alert. (The empty second `alert` is Next's route announcer, so
    // filter to the one carrying text.)
    const alert = page.getByRole('alert').filter({ hasText: /\S/ });
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('User signs in with valid credentials', async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('Form disabled while submitting', async ({ page }) => {
    // Delay (but still forward) the real credentials callback so the in-flight
    // submitting state is observable. The request still hits the real backend.
    await page.route('**/api/auth/callback/credentials', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    const { email, password } = getTestCredentials();
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await page.locator('#signin-email').fill(email);
    await page.locator('#signin-password').fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.locator('#signin-email')).toBeDisabled();
    await expect(page.locator('#signin-password')).toBeDisabled();
    await expect(page.getByText('Signing in...')).toBeVisible();
  });

  test('Authenticated user navigates to the login page', async ({ page }) => {
    await signIn(page); // sets a real session cookie, lands on /dashboard

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
