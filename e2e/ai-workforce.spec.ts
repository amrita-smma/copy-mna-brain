import { test, expect, Page } from '@playwright/test';
import { encryptOverrides } from 'flags';
import { mockAuthSession } from './helpers/auth';

/**
 * Force Vercel flag values for the duration of a test by minting the
 * `vercel-flag-overrides` cookie the Flags SDK reads. The cookie is signed with
 * the same `FLAGS_SECRET` the e2e web server verifies against (set in
 * playwright.config.ts), so overrides win over the live adapter value — making
 * server-side, flag-gated routes deterministic regardless of the developer's
 * linked Vercel project.
 */
const overrideFlags = async (page: Page, overrides: Record<string, boolean>) => {
  const value = await encryptOverrides(overrides);
  await page.context().addCookies([
    { name: 'vercel-flag-overrides', value, url: 'http://localhost:3000' },
  ]);
};

// `/ai-workforce` is gated by the `AI_WORKFORCE_ENABLED` Vercel flag, resolved
// server-side during SSR (so it can't be stubbed via `page.route`). The e2e
// web server blanks the `FLAGS` connection (see playwright.config.ts), so every
// flag falls back to its off-by-default value regardless of the developer's
// linked Vercel project. These tests cover the two deterministic outcomes of
// that gate. Rendering the view itself requires a `vercel-flag-overrides`
// cookie minted with `FLAGS_SECRET`, a deployment concern outside e2e scope.

test.describe('AI Workforce page', () => {
  test('Unauthenticated user opens AI Workforce', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/ai-workforce');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user opens AI Workforce while the feature flag is off', async ({ page }) => {
    await mockAuthSession(page);
    await overrideFlags(page, { AI_WORKFORCE_ENABLED: false });

    await page.goto('/ai-workforce');
    await expect(page).toHaveURL(/\/ai-workforce/);
  });
});
