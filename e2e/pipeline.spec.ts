import { test, expect, Page } from '@playwright/test';
import { MOCK_USER, mockAuthSession } from './helpers/auth';

type Company = {
  id: string;
  target: string | null;
  segment: string | null;
  website?: string | null;
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
  pic?: string | null;
  remarks: string | null;
  review_state: string;
  doc_type: string | null;
  banker_source: string | null;
  possible_duplicate_company_id: string | null;
  created_at: string;
  updated_at: string;
};

const baseCompany = (overrides: Partial<Company>): Company => ({
  id: 'co-0',
  target: 'Acme Corp',
  segment: 'Technology',
  website: null,
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
  l1_screening_result: null,
  pic: null,
  remarks: null,
  review_state: 'reviewed',
  doc_type: null,
  banker_source: null,
  possible_duplicate_company_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
  ...overrides,
});

const MOCK_COMPANIES: Company[] = [
  baseCompany({ id: 'co-1', target: 'Acme Corp', segment: 'Technology', pipeline_stage: 'L0' }),
  baseCompany({ id: 'co-2', target: 'Globex', segment: 'Finance', pipeline_stage: 'L0' }),
  baseCompany({ id: 'co-3', target: 'Initech', segment: 'Technology', pipeline_stage: 'L1', l1_screening_result: 'Pass' }),
  baseCompany({ id: 'co-4', target: 'Umbrella', segment: 'Healthcare', pipeline_stage: 'L1', l1_screening_result: 'No' }),
  baseCompany({ id: 'co-5', target: 'Stark Industries', segment: 'Manufacturing', pipeline_stage: 'L2' }),
  baseCompany({ id: 'co-6', target: 'Wayne Enterprises', segment: 'Manufacturing', pipeline_stage: 'L3' }),
  baseCompany({ id: 'co-7', target: 'Tyrell', segment: 'Biotech', pipeline_stage: 'L4' }),
  baseCompany({ id: 'co-8', target: 'Wonka', segment: 'Consumer', pipeline_stage: 'L5' }),
];

const mockApis = async (page: Page, companies: Company[], opts?: { favorites?: string[] }) => {
  const favoritesState: string[] = [...(opts?.favorites ?? [])];

  await page.route('**/api/companies**', (route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());

    if (url.pathname === '/api/companies/triage') {
      if (method === 'GET') {
        const source = url.searchParams.get('source');
        const count = companies.filter(
          (c) =>
            c.review_state === 'unreviewed' &&
            (!source || source === 'all' || c.source === source),
        ).length;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { count } }),
        });
      }

      if (method === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      }
    }

    if (method === 'GET') {
      if (url.searchParams.get('countOnly') === 'true') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { count: 0 } }),
        });
      }
      const id = url.searchParams.get('id');
      if (id) {
        const match = companies.find((c) => c.id === id) || null;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: match }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: companies }),
      });
    }

    return route.fallback();
  });

  await page.route('**/api/users/*/favorites**', (route) => {
    const method = route.request().method();
    if (method === 'PATCH') {
      const body = JSON.parse(route.request().postData() || '{}') as { companyId?: string };
      if (body.companyId) {
        const idx = favoritesState.indexOf(body.companyId);
        if (idx >= 0) favoritesState.splice(idx, 1);
        else favoritesState.push(body.companyId);
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [...favoritesState] }),
    });
  });

  // Supporting panels on L0 — stub with empty/no-op payloads so the page settles.
  await page.route('**/api/market-screening**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.route('**/api/screenings**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.route('**/api/investment-thesis**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null }) }),
  );
};

test.describe('Pipeline page', () => {
  test('Unauthenticated user opens the Pipeline', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/pipeline');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user views the Pipeline', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline'),
    ]);

    await expect(page.getByRole('heading', { name: 'Deal Pipeline', level: 1 })).toBeVisible();
    await expect(page.getByText('Track companies through all stages')).toBeVisible();

    for (const stage of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
      await expect(page.getByRole('tab', { name: new RegExp(`^${stage}\\s`) })).toBeVisible();
    }

    // Count badges within each tab trigger (2 in L0, 2 in L1, 1 in L2–L5).
    await expect(page.getByRole('tab', { name: /^L0\s+2$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^L1\s+2$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^L2\s+1$/ })).toBeVisible();
  });

  test('User opens the Pipeline with ?stage=L2', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L2'),
    ]);

    await expect(page.getByRole('tab', { name: /^L2\s+1$/ })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('heading', { name: /L2 - Initial Review/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stark Industries', exact: true })).toBeVisible();
  });

  test('User switches pipeline stage tabs', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L1'),
    ]);

    await page.getByRole('tab', { name: /^L3\s+1$/ }).click();
    await expect(page).toHaveURL(/\/pipeline\?stage=L3/);
    await expect(page.getByRole('button', { name: 'Wayne Enterprises', exact: true })).toBeVisible();
  });

  test('User searches within a stage', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L1'),
    ]);

    await expect(page.getByRole('button', { name: 'Initech', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Umbrella', exact: true })).toBeVisible();

    await page.getByPlaceholder('Search companies or sectors...').fill('initech');
    await expect(page.getByRole('button', { name: 'Initech', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Umbrella', exact: true })).not.toBeVisible();
  });

  test('User filters L1 by screening status', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L1'),
    ]);

    await page.getByRole('combobox').filter({ hasText: /Status|All Status/ }).click();
    await page.getByRole('option', { name: 'Pass', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Initech', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Umbrella', exact: true })).not.toBeVisible();
  });

  test('User clicks a company in the Pipeline', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);
    await page.route('**/api/deal-notes**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );
    await page.route('**/api/deal-links**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );
    await page.route('**/api/deal-documents**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L3'),
    ]);

    await page.getByRole('button', { name: 'Wayne Enterprises', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('User stars a company', async ({ page }) => {
    await mockAuthSession(page, MOCK_USER);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L2'),
    ]);

    const starBtn = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Stark Industries', exact: true }) })
      .locator('button:has(svg.lucide-star)');

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/favorites')),
      starBtn.click(),
    ]);
    expect(JSON.parse(req.postData() || '{}')).toEqual({ companyId: 'co-5' });
  });

  test('User views a stage with no companies', async ({ page }) => {
    await mockAuthSession(page);
    // Only L0 data, so L4 will be empty.
    const onlyL0 = MOCK_COMPANIES.filter((c) => c.pipeline_stage === 'L0');
    await mockApis(page, onlyL0);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L4'),
    ]);

    await expect(page.getByText('No companies in this stage')).toBeVisible();
  });

  test('User triages unreviewed inbound companies', async ({ page }) => {
    const companies = [
      baseCompany({
        id: 'triage-1',
        target: 'PT Sinar Teknologi',
        segment: 'Technology',
        source: 'inbound',
        pipeline_stage: 'L0',
        review_state: 'unreviewed',
        doc_type: 'teaser',
        banker_source: 'Goldman Sachs',
      }),
      baseCompany({
        id: 'triage-2',
        target: 'BrightStar Energy',
        segment: 'Energy',
        source: 'inbound',
        pipeline_stage: 'L0',
        review_state: 'unreviewed',
        doc_type: 'shopping_list',
        banker_source: 'UBS',
        revenue_2024_usd_mn: null,
        ebitda_2024_usd_mn: null,
      }),
      baseCompany({
        id: 'reviewed-1',
        target: 'Reviewed Industrials',
        segment: 'Manufacturing',
        source: 'inbound',
        pipeline_stage: 'L0',
      }),
      baseCompany({
        id: 'market-1',
        target: 'Indonesia Data Centers',
        segment: 'Infrastructure',
        source: 'outbound',
        pipeline_stage: 'L0',
        doc_type: 'market_study',
      }),
    ];

    await mockAuthSession(page);
    await mockApis(page, companies);
    let triagePayload: unknown = null;
    await page.route('**/api/companies/triage', (route) => {
      if (route.request().method() === 'POST') {
        triagePayload = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { count: 2 } }),
      });
    });

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L0'),
    ]);

    await expect(page.getByRole('button', { name: /Triage Unreviewed\s+2/ })).toBeVisible();
    await expect(page.getByText('2 new companies from banker emails')).toBeVisible();

    await page.getByRole('button', { name: /Triage Unreviewed\s+2/ }).click();
    await expect(page.getByRole('dialog', { name: 'Triage Unreviewed Companies' })).toBeVisible();
    await expect(page.getByText('PT Sinar Teknologi')).toBeVisible();
    await expect(page.getByText('Goldman Sachs')).toBeVisible();

    await page
      .locator('div')
      .filter({ hasText: 'PT Sinar Teknologi' })
      .getByRole('button', { name: 'Keep' })
      .first()
      .click();
    await page
      .locator('div')
      .filter({ hasText: 'BrightStar Energy' })
      .getByRole('button', { name: 'Drop' })
      .first()
      .click();
    await page.getByRole('combobox').filter({ hasText: 'Select reason' }).click();
    await page.getByRole('option', { name: 'Insufficient information' }).click();

    await page.getByRole('button', { name: 'Apply 2 decisions' }).click();

    expect(triagePayload).toEqual({
      decisions: [
        { id: 'triage-1', action: 'keep' },
        { id: 'triage-2', action: 'drop', reason: 'Insufficient information' },
      ],
    });
  });
});
