import { test, expect } from '@playwright/test';
import { MOCK_USER, mockAuthSession, mockNextAuthSignIn } from './helpers/auth';
import { getTestCredentials } from './helpers/credentials';

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    // Stub the dashboard's data fetches so any post-login navigation lands
    // cleanly without hitting the real API.
    await page.route('**/api/companies**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      }),
    );
  });

  test('Unauthenticated user opens the login page', async ({ page }) => {
    await mockAuthSession(page, null);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'BRAIN 2.0' })).toBeVisible();
    await expect(page.locator('#signin-email')).toBeVisible();
    await expect(page.locator('#signin-password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('User submits a wrong email/password combination', async ({ page }) => {
    await mockAuthSession(page, null);
    await mockNextAuthSignIn(page, { errorCode: 'CredentialsSignin' });
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await page.locator('#signin-email').fill('wrong@example.com');
    await page.locator('#signin-password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // useAuth wraps NextAuth's `error` value as the message; ensure our error
    // alert renders with the code (the second `alert` is Next's route announcer).
    const alert = page.getByRole('alert').filter({ hasText: /CredentialsSignin/i });
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('User signs in with valid credentials', async ({ page }) => {
    const session = await mockAuthSession(page, null);
    await mockNextAuthSignIn(page);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const { email, password } = getTestCredentials();
    await page.locator('#signin-email').fill(email);
    await page.locator('#signin-password').fill(password);

    // Flip the session to authenticated right before submit so the post-signin
    // session refresh and the dashboard's ProtectedRoute see a valid user.
    session.setUser(MOCK_USER);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('Form disabled while submitting', async ({ page }) => {
    await mockAuthSession(page, null);
    await mockNextAuthSignIn(page, { delayMs: 700 });
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await page.locator('#signin-email').fill('test@example.com');
    await page.locator('#signin-password').fill('password123');
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.locator('#signin-email')).toBeDisabled();
    await expect(page.locator('#signin-password')).toBeDisabled();
    await expect(page.getByText('Signing in...')).toBeVisible();
  });

  test('Authenticated user navigates to the login page', async ({ page }) => {
    await mockAuthSession(page, MOCK_USER);

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
