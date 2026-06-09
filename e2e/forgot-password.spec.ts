import { test, expect } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

/**
 * Forgot-password regression suite (REG-FP-* from the 2026 MnA test sheet).
 *
 * The "Forgot password?" link on /login points at /reset-password, which
 * renders the email-request form when no `?token=` is present
 * (src/app/reset-password/page.tsx). The request endpoint
 * `/api/auth/forget-password` always responds `{ ok: true }` and never reveals
 * whether the email exists (anti-enumeration), so the UI shows the same generic
 * message for registered and unregistered addresses.
 *
 */
test.describe('Forgot Password', () => {
  test.beforeEach(async ({ page }) => {
    // /login renders behind a session fetch; resolve it as unauthenticated so
    // the page settles instead of redirecting to /dashboard.
    await mockAuthSession(page, null);
  });

  // REG-FP-01 — Login page shows Forgot Password link
  test('login page shows Forgot Password link', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const link = page.getByRole('link', { name: 'Forgot password?' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/reset-password');
  });

  // REG-FP-02 — Forgot password page renders form
  test('forgot password page renders form', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await page.getByRole('link', { name: 'Forgot password?' }).click();

    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByRole('heading', { name: 'Reset Password' })).toBeVisible();
    await expect(page.locator('#reset-email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send Reset Link' })).toBeVisible();

    // No error message is shown on a freshly rendered form.
    await expect(page.getByText(/failed|invalid/i)).toHaveCount(0);
  });

  // REG-FP-06 — Unregistered email shows generic (anti-enumeration) success message
  test('unregistered email shows generic success message', async ({ page }) => {
    // The endpoint returns the same { ok: true } regardless of whether the
    // email exists; mock it so the test is hermetic (no real SES enqueue).
    await page.route('**/api/auth/forget-password', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      }),
    );

    await page.goto('/reset-password', { waitUntil: 'domcontentloaded' });

    await page.locator('#reset-email').fill('notregistered@example.com');
    await page.getByRole('button', { name: 'Send Reset Link' }).click();

    // Generic message that does not disclose whether the account exists.
    await expect(
      page.getByText(/If an account exists for that email/i),
    ).toBeVisible();
    // The page stays on /reset-password (no redirect, no enumeration leak).
    await expect(page).toHaveURL(/\/reset-password$/);
  });
});
