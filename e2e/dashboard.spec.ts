import { test, expect, Page } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

type Company = {
  id: string;
  target: string | null;
  segment: string | null;
  watchlist_status: string | null;
  source: string | null;
  pipeline_stage: string | null;
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  ev_2024: number | null;
  l1_screening_result: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
};

const baseCompany = (overrides: Partial<Company>): Company => ({
  id: overrides.id ?? 'co-0',
  target: 'Acme Corp',
  segment: 'Technology',
  watchlist_status: null,
  source: 'inbound',
  pipeline_stage: 'L0',
  revenue_2021_usd_mn: 100,
  revenue_2022_usd_mn: 120,
  revenue_2023_usd_mn: 150,
  revenue_2024_usd_mn: 180,
  ebitda_2021_usd_mn: 10,
  ebitda_2022_usd_mn: 15,
  ebitda_2023_usd_mn: 20,
  ebitda_2024_usd_mn: 25,
  ev_2024: 500,
  l1_screening_result: 'pass',
  remarks: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
  ...overrides,
});

// The dashboard caches /api/companies for the detail dialog and uses it for the
// initial (pre-activity) stage counts. The stat cards / recap / feed, however,
// are driven entirely by /api/dashboard/activity (see below).
const MOCK_COMPANIES: Company[] = [
  baseCompany({ id: 'co-1', target: 'Acme Corp', pipeline_stage: 'L0', source: 'inbound' }),
  baseCompany({ id: 'co-2', target: 'Globex', pipeline_stage: 'L0', source: 'inbound' }),
  baseCompany({ id: 'co-3', target: 'Initech', pipeline_stage: 'L0', source: 'outbound' }),
  baseCompany({ id: 'co-4', target: 'Umbrella', pipeline_stage: 'L0', source: 'outbound' }),
];

const mockCompanies = (page: Page, companies: Company[]) =>
  page.route('**/api/companies?**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: companies }),
    });
  });

// ─── Dashboard activity mock ─────────────────────────────────────────────────
// The stat cards derive their numbers from this payload:
//   - each `newL0Companies` entry counts toward stage L0
//   - each `pipelineMoves` entry counts toward its parsed target stage
// The fixture below yields: Total 8, Inbound 4, Outbound 4, L0 4 / L5 2 → 50%.

type ActivityPayload = {
  newL0Companies: unknown[];
  aiSourcedCompanies: unknown[];
  pipelineMoves: unknown[];
  slidesGenerated: unknown[];
  droppedDeals: unknown[];
  workforceJobs: unknown[];
  newContacts: unknown[];
  notesUpdated: unknown[];
};

const EMPTY_ACTIVITY: ActivityPayload = {
  newL0Companies: [],
  aiSourcedCompanies: [],
  pipelineMoves: [],
  slidesGenerated: [],
  droppedDeals: [],
  workforceJobs: [],
  newContacts: [],
  notesUpdated: [],
};

const newDeal = (id: string, target: string, source: string, event_at: string) => ({
  id,
  target,
  project_name: null,
  source,
  segment: 'Technology',
  geography: 'US',
  remarks: null,
  thesis_content: null,
  event_at,
  reason: 'created' as const,
});

const move = (id: string, company_id: string, target: string, action: string, source: string, created_at: string) => ({
  id,
  company_id,
  action,
  created_at,
  target,
  project_name: null,
  segment: 'Technology',
  geography: 'US',
  source,
  remarks: null,
  thesis_content: null,
});

const MOCK_ACTIVITY: ActivityPayload = {
  ...EMPTY_ACTIVITY,
  // 4 new L0 deals (2 inbound, 2 outbound) → L0 = 4
  newL0Companies: [
    newDeal('co-1', 'Acme Corp', 'inbound', '2026-06-07T10:00:00Z'),
    newDeal('co-2', 'Globex', 'inbound', '2026-06-06T10:00:00Z'),
    newDeal('co-3', 'Initech', 'outbound', '2026-06-06T09:00:00Z'),
    newDeal('co-4', 'Umbrella', 'outbound', '2026-06-05T10:00:00Z'),
  ],
  // 4 stage moves → L1 (in), L2 (out), L5 (in), L5 (out)
  pipelineMoves: [
    move('log-1', 'co-5', 'Stark Industries', 'PROMOTED_TO_L1', 'inbound', '2026-06-07T11:00:00Z'),
    move('log-2', 'co-6', 'Wayne Enterprises', 'PROMOTED_FROM_L1_TO_L2', 'outbound', '2026-06-06T11:00:00Z'),
    move('log-3', 'co-7', 'Tyrell', 'PROMOTED_TO_L5', 'inbound', '2026-06-06T08:00:00Z'),
    move('log-4', 'co-8', 'Wonka', 'PROMOTED_FROM_L4_TO_L5', 'outbound', '2026-06-05T11:00:00Z'),
  ],
  droppedDeals: [
    {
      id: 'co-9',
      target: 'Soylent',
      project_name: null,
      pipeline_stage: 'L2',
      dropped_at: '2026-06-06T12:00:00Z',
      dropped_reason: 'Out of thesis',
      segment: 'Food',
      geography: 'US',
      source: 'inbound',
      thesis_content: null,
    },
  ],
};

const mockActivity = (page: Page, activity: ActivityPayload) =>
  page.route('**/api/dashboard/activity**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: activity }),
    });
  });

// ─── Mobile activity feed mock ───────────────────────────────────────────────
// The mobile feed paginates over /api/dashboard/feed (offset/limit), newest
// first. The fixture below yields 20 events so the first page (limit 15) leaves
// more, exercising infinite scroll.

type FeedEvent = {
  id: string;
  type: 'new_deal' | 'stage_move' | 'dropped' | 'note_updated';
  company_id: string;
  company_name: string;
  segment: string | null;
  geography: string | null;
  source: string | null;
  event_at: string;
  dropped_stage?: string | null;
  dropped_reason?: string | null;
};

const FEED_EVENTS: FeedEvent[] = Array.from({ length: 20 }, (_, i) => ({
  id: `feed-${i}`,
  type: i === 0 ? 'dropped' : 'new_deal',
  company_id: `co-feed-${i}`,
  company_name: `Feed Co ${i}`,
  segment: 'Technology',
  geography: 'US',
  source: i % 2 === 0 ? 'inbound' : 'outbound',
  // Descending timestamps so the merged stream is already newest-first.
  event_at: new Date(Date.UTC(2026, 5, 18, 0, 0, 0) - i * 3_600_000).toISOString(),
  ...(i === 0 ? { dropped_stage: 'L2', dropped_reason: 'Out of thesis' } : {}),
}));

const mockFeed = (page: Page, events: FeedEvent[]) =>
  page.route('**/api/dashboard/feed?**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset')) || 0;
    const limit = Number(url.searchParams.get('limit')) || 15;
    const slice = events.slice(offset, offset + limit);
    const hasMore = offset + limit < events.length;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { events: slice, hasMore } }),
    });
  });

/** Reads the big number in a stat card, scoped to the 4-card stat grid. */
const statValue = (page: Page, label: string) =>
  page
    .locator('main')
    .locator('div.grid')
    .filter({ hasText: 'Total Deals' })
    .first()
    .locator('div.p-5')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('p.text-3xl');

test.describe('Dashboard page', () => {
  test('Unauthenticated user opens the dashboard', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user views the dashboard with activity', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
    await mockActivity(page, MOCK_ACTIVITY);
    await page.goto('/dashboard');

    // Header
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Real-time overview of your M&A deal pipeline')).toBeVisible();

    // Stat cards — derived from MOCK_ACTIVITY (8 total, 4 inbound, 4 outbound,
    // L0 4 / L5 2 → 50% conversion).
    await expect(statValue(page, 'Total Deals')).toHaveText('8');
    await expect(statValue(page, 'Inbound')).toHaveText('4');
    await expect(statValue(page, 'Outbound')).toHaveText('4');
    await expect(statValue(page, 'Conversion')).toHaveText('50%');

    const conversionCard = page
      .locator('main')
      .locator('div.p-5')
      .filter({ has: page.getByText('Conversion', { exact: true }) });
    await expect(conversionCard.getByText('L0 → L5')).toBeVisible();

    // 7-Day Recap counters: 4 new deals, 1 dropped, 4 stage moves.
    const main = page.locator('main');
    await expect(main.getByText('7-Day Recap')).toBeVisible();

    // Pipeline Stages bar chart — one /pipeline?stage=Lx link per stage.
    await expect(main.getByText('Pipeline Stages')).toBeVisible();
    for (const stage of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
      await expect(
        main.getByRole('link', { name: new RegExp(`\\b${stage}\\b`) }).first(),
      ).toBeVisible();
    }

    // Activity Feed lists the events; Acme Corp appears as a clickable entry.
    await expect(main.getByText('Activity Feed')).toBeVisible();
    await expect(main.getByRole('button', { name: 'Acme Corp' })).toBeVisible();
  });

  test('User clicks a pipeline stage link on the dashboard', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
    await mockActivity(page, MOCK_ACTIVITY);
    await page.goto('/dashboard');

    const l2Link = page
      .locator('main')
      .getByRole('link')
      .filter({ hasText: /^\d+[\s\S]*L2/ })
      .first();
    const href = await l2Link.getAttribute('href');
    expect(href).toBe('/pipeline?stage=L2');
  });

  test('User clicks a company in the activity feed', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
    await mockActivity(page, MOCK_ACTIVITY);
    // Single-company fetch fallback (the cache should already hold co-1).
    await page.route('**/api/companies/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { logs: [], notes: [], links: [], documents: [] },
        }),
      }),
    );
    await page.goto('/dashboard');

    await page.locator('main').getByRole('button', { name: 'Acme Corp' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('Dashboard loads with no activity in the period', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, []);
    await mockActivity(page, EMPTY_ACTIVITY);

    await page.goto('/dashboard');

    const main = page.locator('main');
    await expect(main.getByText('No pipeline activity in this period.')).toBeVisible();
    await expect(main.getByText('No activity in this period')).toBeVisible();
    await expect(statValue(page, 'Total Deals')).toHaveText('0');
  });

  test('Mobile activity feed scrolls infinitely with no date selector', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
    await mockActivity(page, MOCK_ACTIVITY);
    await mockFeed(page, FEED_EVENTS);

    await page.goto('/dashboard');

    const main = page.locator('main');

    // The date-range selector is desktop-only — hidden on mobile.
    await expect(main.getByRole('button', { name: '7 days' })).toBeHidden();

    // First page renders (newest first). The newest event is a dropped deal
    // with a contextual "Analyze why ... was dropped" pill.
    await expect(main.getByRole('button', { name: 'Feed Co 0' })).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Analyze why Feed Co 0 was dropped' }),
    ).toBeVisible();

    // A page-2 event is not present until we scroll to the bottom.
    await expect(main.getByRole('button', { name: 'Feed Co 18' })).toHaveCount(0);

    // Scroll to the bottom to trip the infinite-scroll sentinel.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    await expect(main.getByRole('button', { name: 'Feed Co 18' })).toBeVisible();
  });

  test('Dashboard data fetch is still pending', async ({ page }) => {
    await mockAuthSession(page);
    await mockActivity(page, MOCK_ACTIVITY);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    await page.route('**/api/companies?**', async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: MOCK_COMPANIES }),
      });
    });

    await page.goto('/dashboard');
    await expect(page.getByText('Loading dashboard...')).toBeVisible();

    release();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Loading dashboard...')).not.toBeVisible();
  });
});
