import type { Page } from '@playwright/test';

/**
 * Keep the AI CoPilot pane collapsed for the logged-in shell.
 *
 * After login the app lands on the chat landing, where `AppShell` gives the
 * whole console to the copilot. On a data page (e.g. `/master-data`) an
 * expanded pane collapses the main content to `width: 0 / opacity: 0`, hiding
 * the very page under test.
 *
 * Seed the persisted flag to `false` via an init script. Playwright runs it
 * before page scripts on *every* navigation, so the pane stays collapsed on
 * data routes. The landing route ignores the flag (it derives expansion from
 * the route, having no console content to show), but data-page specs don't
 * assert there.
 *
 * Call once before navigating to the page under test (registering it before or
 * after `signIn` is fine — it applies to all subsequent navigations).
 */
export const collapseCopilot = (page: Page) =>
  page.addInitScript(() => {
    window.localStorage.setItem('layout:copilot-expanded', 'false');
  });

/**
 * Make sure every nav section in the sidebar is expanded, so a spec can assert
 * on the page links inside them.
 *
 * The links live in collapsible sections ("Deal Flow", "Intelligence") that are
 * open by default — but the state is persisted per browser profile, so a spec
 * must not assume it. Expands only what is closed. (These links used to sit
 * behind a "Pages" tab, and before that in a strip over the console.)
 */
export const openPagesNav = async (page: Page) => {
  for (const id of ['deal-flow', 'intelligence']) {
    const header = page.getByTestId(`sidebar-section-${id}`);
    await header.waitFor();
    if ((await header.getAttribute('aria-expanded')) === 'false') {
      await header.click();
    }
  }
};
