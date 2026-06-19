import { test, expect } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

// `/ai-workforce` is no longer flag-gated: the page renders for any
// authenticated user and redirects unauthenticated visitors to login. These
// tests cover those two outcomes.

test.describe('AI Workforce page', () => {
  test('Unauthenticated user opens AI Workforce', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/ai-workforce');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user opens AI Workforce', async ({ page }) => {
    await mockAuthSession(page);

    await page.goto('/ai-workforce');
    await expect(page).toHaveURL(/\/ai-workforce/);
  });
});
