import type { Page } from '@playwright/test';

/**
 * Keep the AI CoPilot pane collapsed for the logged-in shell.
 *
 * After login the app lands on `/chat`, where `DashboardLayout` forces
 * `layout:copilot-expanded = true` and persists it to localStorage. That flag
 * survives navigation, so on a data page (e.g. `/master-data`) the expanded
 * pane collapses the main content to `width: 0 / opacity: 0`, hiding the very
 * page under test.
 *
 * Seed the persisted flag to `false` via an init script. Playwright runs it
 * before page scripts on *every* navigation, so the pane stays collapsed on
 * data routes (which never re-expand it). The `/chat` route still re-expands
 * the pane post-mount, but data-page specs don't assert there.
 *
 * Call once before navigating to the page under test (registering it before or
 * after `signIn` is fine — it applies to all subsequent navigations).
 */
export const collapseCopilot = (page: Page) =>
  page.addInitScript(() => {
    window.localStorage.setItem('layout:copilot-expanded', 'false');
  });
