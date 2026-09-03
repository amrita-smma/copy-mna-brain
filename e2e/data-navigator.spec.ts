import { test, expect, Page } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';
import { collapseCopilot } from './helpers/layout';

/**
 * Requires `DATA_NAVIGATOR_ENABLED=true` (set in `.env.local`) and the RSS
 * fixture data seeded by the pipeline (`data-pipeline/migrations` +
 * poller) — 269 real/seeded items across all five categories at the time
 * this suite was written. The page itself renders regardless of the flag
 * (only the sidebar nav entry is flag-gated), so a direct navigation works
 * whether or not the flag happens to be on, but the flag is still required
 * for the flag-gated nav item to exist elsewhere in the app.
 *
 * Data-navigator's news feed is NOT workspace-scoped (the RSS catalog is
 * shared platform-wide, see `container.ts`), so the mocked session's
 * fake `mock-workspace` membership is sufficient to pass the `/w/[slug]`
 * membership gate while every list/search/preview request still hits the
 * real local Postgres — no `page.route()` mocking of the data-navigator API
 * itself, unlike `smart-files.spec.ts`.
 */

/** Sign in, land on the Data Navigator page and wait for the first page of items. */
const openDataNavigator = async (page: Page) => {
  await collapseCopilot(page);
  await mockAuthSession(page);
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes('/api/data-navigator/items') &&
        !res.url().includes('cursorId') &&
        res.status() === 200,
    ),
    // Flat legacy path — the app bridges it to /w/<slug>/data-navigator via
    // the session's own workspace slug (see legacyWorkspaceRedirect.ts).
    page.goto('/data-navigator'),
  ]);
};

const newsList = (page: Page) => page.getByRole('listbox', { name: 'News items' });
const newsOptions = (page: Page) => newsList(page).getByRole('option');
/** The headline text within an option row. */
const optionTitle = (page: Page, index: number) =>
  newsOptions(page).nth(index).getByTestId('news-item-title');

test.describe('Data Navigator', () => {
  test('lists news items and previews the first one', async ({ page }) => {
    await openDataNavigator(page);

    const options = newsOptions(page);
    await expect(options.first()).toBeVisible();
    // 269 seeded/real items across 5 categories → a full first page.
    await expect(options).toHaveCount(50);

    // The first item is auto-selected.
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    const firstTitle = await optionTitle(page, 0).innerText();
    const article = page.getByRole('article');
    await expect(article).toBeVisible();
    await expect(article.locator('h2')).toHaveText(firstTitle);
  });

  test('selecting a different item swaps the preview and moves aria-selected', async ({ page }) => {
    await openDataNavigator(page);

    const options = newsOptions(page);
    const secondTitle = await optionTitle(page, 1).innerText();

    await options.nth(1).click();

    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.first()).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('article').locator('h2')).toHaveText(secondTitle);
  });

  test('a translated item reads in English and can be flipped to the original', async ({
    page,
  }) => {
    await openDataNavigator(page);
    await expect(newsOptions(page).first()).toBeVisible();

    // The seeded corpus carries two non-English fixtures (German and
    // Japanese) with an English translation — see `story.original` in
    // `scripts/seed.ts` — so at least one badged card is always on page one.
    const translated = newsOptions(page).filter({
      has: page.getByTestId('news-item-translated'),
    });
    await expect(translated.first()).toBeVisible();

    // The card shows the English headline; the badge says where it came from.
    const englishTitle = (
      await translated.first().getByTestId('news-item-title').innerText()
    ).trim();

    await translated.first().click();

    const article = page.getByRole('article');
    await expect(article.locator('h2')).toHaveText(englishTitle);
    await expect(page.getByTestId('news-translation-notice')).toContainText(
      'Machine-translated',
    );

    // Flipping to the original must actually change the rendered headline —
    // if the toggle silently kept showing the translation, this fails.
    const toggle = page.getByTestId('news-translation-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(article.locator('h2')).not.toHaveText(englishTitle);

    // And back.
    await toggle.click();
    await expect(article.locator('h2')).toHaveText(englishTitle);

    // The choice is per-article, not sticky: moving to an English item must
    // not leave the pane in "original" mode. Picked by the absence of the
    // badge rather than by index, since the feed is also live-polled and a
    // real non-English item could occupy any position.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const untranslated = newsOptions(page).filter({
      hasNot: page.getByTestId('news-item-translated'),
    });
    await untranslated.first().click();
    await expect(page.getByTestId('news-translation-toggle')).toHaveCount(0);
  });

  test('a category chip narrows the list and Clear restores it', async ({ page }) => {
    await openDataNavigator(page);

    const options = newsOptions(page);
    const before = await options.count();

    // "Industry Reports" is the smallest category in the seeded set (well
    // under the 50-row page size), so filtering to it is guaranteed to
    // shrink the list — unlike a larger category whose filtered result
    // would still fill a full page and look unchanged.
    const chip = page.getByRole('button', { name: 'Industry Reports' });
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/data-navigator/items') &&
          res.url().includes('category=industry_reports') &&
          res.status() === 200,
      ),
      chip.click(),
    ]);

    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => options.count()).toBeLessThan(before);

    const clear = page.getByRole('button', { name: 'Clear' });
    await expect(clear).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/data-navigator/items') &&
          !res.url().includes('category=') &&
          res.status() === 200,
      ),
      clear.click(),
    ]);

    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => options.count()).toBe(before);
    await expect(clear).not.toBeVisible();
  });

  test('search replaces the feed with ranked matches', async ({ page }) => {
    await openDataNavigator(page);

    const options = newsOptions(page);
    const firstTitle = (await optionTitle(page, 0).innerText()).trim();

    // Draw the query from an item further down the list (not item 0) rather
    // than a hardcoded headline — the feed is live-polled, so a specific
    // title is not guaranteed to exist on a future run. Deliberately NOT
    // item 0: a degenerate "search" that silently falls back to the
    // unfiltered, date-ordered feed would keep item 0 first regardless of
    // the query, so a term drawn from item 0 can't distinguish real
    // filtering from that fallback. Guard against the term coincidentally
    // also appearing in item 0's own title by trying later candidates until
    // one doesn't.
    let term: string | undefined;
    for (let index = 5; index < 20 && !term; index++) {
      const candidateTitle = (await optionTitle(page, index).innerText()).trim();
      const candidate = candidateTitle
        .split(/\s+/)
        .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter((word) => word.length >= 4)
        .sort((a, b) => b.length - a.length)[0];
      if (candidate && !firstTitle.toLowerCase().includes(candidate.toLowerCase())) {
        term = candidate;
      }
    }
    expect(term, 'expected a distinctive word, absent from the first item’s title, further down the list').toBeTruthy();

    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/data-navigator/search') && res.status() === 200,
      ),
      page.getByLabel('Search news').fill(term!),
    ]);

    // Inclusion: `textSearch` (chunks are empty, so this is lexical-only —
    // see module doc) ILIKE-matches title/authors/source_name, so a term
    // drawn verbatim from a visible title is guaranteed to surface at least
    // one result containing it.
    await expect.poll(async () => {
      const titles = await options.getByTestId('news-item-title').allInnerTexts();
      return titles.some((title) => title.toLowerCase().includes(term!.toLowerCase()));
    }).toBe(true);

    // Exclusion: the item the unfiltered feed puts first must now be gone.
    // This is the assertion that actually catches "search" degenerating
    // into the unfiltered, date-ordered feed — the inclusion check alone
    // can't, because item 0 also ranks first in that fallback.
    const titles = await options.getByTestId('news-item-title').allInnerTexts();
    expect(titles).not.toContain(firstTitle);
  });

  test('ArrowUp/ArrowDown move the selection but are ignored while the search input is focused', async ({
    page,
  }) => {
    await openDataNavigator(page);
    const options = newsOptions(page);
    await expect(options).toHaveCount(50);

    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.first()).toHaveAttribute('aria-selected', 'false');

    await page.keyboard.press('ArrowUp');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    // Focus inside the search input: the same key must not steal the
    // selection away from whatever the user is typing.
    await page.getByLabel('Search news').focus();
    await page.keyboard.press('ArrowDown');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');
  });

  test('infinite scroll does not re-fetch the same cursor twice', async ({ page }) => {
    const cursorIds: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname !== '/api/data-navigator/items') return;
      const cursorId = url.searchParams.get('cursorId');
      if (cursorId) cursorIds.push(cursorId);
    });

    await openDataNavigator(page);
    const list = newsList(page);
    const options = newsOptions(page);
    const sentinel = list.getByTestId('news-list-sentinel');

    let previousCount = await options.count();
    for (let i = 0; i < 2; i++) {
      await sentinel.scrollIntoViewIfNeeded();
      await expect.poll(() => options.count(), { timeout: 15_000 }).toBeGreaterThan(previousCount);
      previousCount = await options.count();
    }

    expect(cursorIds.length).toBeGreaterThan(0);
    expect(new Set(cursorIds).size).toBe(cursorIds.length);
  });

  test('list rows show a visible keyboard focus indicator', async ({ page }) => {
    await openDataNavigator(page);

    // Tab from the search input through the filter chips/switch until focus
    // lands on a list row (role="option").
    await page.getByLabel('Search news').click();
    let focusedRole: string | null = null;
    for (let i = 0; i < 20 && focusedRole !== 'option'; i++) {
      await page.keyboard.press('Tab');
      focusedRole = await page.evaluate(() => document.activeElement?.getAttribute('role') ?? null);
    }
    expect(focusedRole).toBe('option');

    const indicator = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
    });

    // The ring is implemented as a box-shadow (`focus-visible:ring-2`), so
    // that is the assertion that actually proves a visible indicator.
    // outlineStyle/outlineWidth are NOT a reliable secondary signal here:
    // Tailwind's `outline-none` compiles to `outline: 2px solid transparent`
    // rather than `outline: none`, so those two computed properties read as
    // a "real" outline even when the ring classes are stripped and no
    // visible focus state remains.
    expect(
      indicator.boxShadow,
      `expected a visible focus ring (non-"none" box-shadow) on the focused row; computed style was ${JSON.stringify(indicator)}`,
    ).not.toBe('none');
  });
});
