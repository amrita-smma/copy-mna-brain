import { test, expect } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

// `/ai-workforce` is gated by the `AI_WORKFORCE_ENABLED` Vercel flag, which
// defaults to `false` in test environments (no FLAGS_SECRET / Vercel runtime).
// These tests cover the two deterministic outcomes of that gate. Rendering the
// view itself requires a `vercel-flag-overrides` cookie minted with
// `FLAGS_SECRET`, which is a deployment concern outside the scope of e2e.

test.describe('AI Workforce page', () => {
  test('redirects to /login when unauthenticated', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/ai-workforce');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('redirects to /dashboard when authenticated but flag disabled', async ({ page }) => {
    await mockAuthSession(page);

    await page.goto('/ai-workforce');
    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
