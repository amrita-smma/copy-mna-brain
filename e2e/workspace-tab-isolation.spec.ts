import { test, expect, type Page } from '@playwright/test';
import { getTestCredentials } from './helpers/credentials';

/**
 * Regression test for MB-337's URL-scoped workspace design (the "Option B"
 * plan): two tabs sharing one NextAuth session cookie must each stay pinned
 * to their own `/w/<slug>/...` workspace, independent of what the other tab
 * or the shared session cookie currently point to. This is the exact bug the
 * whole `/w/[workspaceSlug]/...` design exists to fix — before this feature,
 * both tabs raced over one cookie and whichever tab fetched data last would
 * silently repoint the other tab's next request.
 *
 * Requires the signed-in test user to belong to 2+ workspaces; skips
 * otherwise (membership count varies by environment/seed data, so this is
 * discovered at runtime rather than hardcoded).
 */

interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}

// `e2e/helpers/auth.ts`'s `signIn()` assumes single-workspace users and waits
// for the post-login redirect straight to `/chat`. A multi-workspace user
// (required here) lands on the `/workspace` picker instead, so this test
// drives the credentials form itself and accepts either destination.
async function signInMultiWorkspace(page: Page): Promise<void> {
  const { email, password } = getTestCredentials();
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-email').fill(email);
  await page.locator('#signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(workspace|w\/)/);
}

async function fetchMemberships(page: Page): Promise<Membership[]> {
  return page.evaluate(async () => {
    const res = await fetch('/api/workspaces');
    const { data } = await res.json();
    return data ?? [];
  });
}

// In-page fetch through the real apiRequest/proxy stack — mirrors what an
// unconverted call site does: no explicit workspace header, relying on the
// tab's own URL (client-side) and the Referer-derived fallback (server-side).
async function fetchCompanyIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const res = await fetch('/api/companies?lite=true', { credentials: 'include' });
    const { data } = await res.json();
    return (data ?? []).map((c: { id: string }) => c.id).sort();
  });
}

test.describe('Multi-tab workspace isolation (MB-337)', () => {
  test('two tabs on two workspaces stay independently scoped, even after one switches', async ({
    page,
    context,
  }) => {
    // Generous timeout: against a dev-mode server (not the prod build+start
    // this config normally boots), first navigation to a not-yet-compiled
    // /w/[workspaceSlug]/... route can take much longer than the default 30s.
    test.setTimeout(90_000);
    test.skip(
      !process.env.LOCAL_TEST_EMAIL || !process.env.LOCAL_TEST_PASSWORD,
      'LOCAL_TEST_EMAIL/LOCAL_TEST_PASSWORD not set (see .env.example) — skipping rather than hard-failing.',
    );
    await signInMultiWorkspace(page);
    const memberships = await fetchMemberships(page);
    test.skip(memberships.length < 2, 'Test user needs 2+ workspace memberships to exercise tab isolation');

    const [wsA, wsB] = memberships;
    const tabA = page;
    const tabB = await context.newPage();

    await tabA.goto(`/w/${wsA.workspaceSlug}/pipeline`);
    await tabA.waitForLoadState('networkidle');
    await tabB.goto(`/w/${wsB.workspaceSlug}/pipeline`);
    await tabB.waitForLoadState('networkidle');

    const idsA = await fetchCompanyIds(tabA);
    const idsB = await fetchCompanyIds(tabB);

    // Each tab's own unconverted-fetch-style call must reflect its own URL's
    // workspace, not whatever the shared session cookie happens to point to.
    expect(idsA).not.toEqual(idsB);

    // Re-assert against each tab's own URL directly (not just the diff above)
    // so a false-pass from both happening to return an empty/equal set for an
    // unrelated reason doesn't slip through.
    expect(tabA.url()).toContain(`/w/${wsA.workspaceSlug}/`);
    expect(tabB.url()).toContain(`/w/${wsB.workspaceSlug}/`);

    // Now use the in-app switcher in tab A only. Tab B must be entirely
    // unaffected — this is the property a shared session cookie cannot
    // provide, and the reason this feature exists.
    const idsBBeforeSwitch = idsB;
    // The sidebar (chat history, with the workspace switcher in its header)
    // starts EXPANDED for a fresh browser profile — `layout:sidebar-open-v2`
    // defaults to true in AppShell.tsx, because a collapsed icon rail has
    // nothing useful to show for a list of chat titles. Toggle only if some
    // stored state left it collapsed, so this doesn't close it by accident.
    const switcher = tabA.getByRole('combobox').filter({ hasText: wsA.workspaceName });
    if (!(await switcher.isVisible())) {
      await tabA.getByRole('button', { name: 'Toggle Sidebar' }).click();
    }
    await switcher.waitFor({ state: 'visible', timeout: 30_000 });
    await switcher.click();
    await tabA.getByRole('option', { name: wsB.workspaceName }).click();
    await tabA.waitForURL(`**/w/${wsB.workspaceSlug}/**`);
    await tabA.waitForLoadState('networkidle');

    const idsAAfterSwitch = await fetchCompanyIds(tabA);
    expect(idsAAfterSwitch).toEqual(idsB); // tab A now matches workspace B's data

    const idsBAfterOtherTabSwitched = await fetchCompanyIds(tabB);
    expect(idsBAfterOtherTabSwitched).toEqual(idsBBeforeSwitch); // tab B untouched

    await tabB.close();
  });
});
