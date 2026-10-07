import { test, expect, Page } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

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

// The six stages every workspace starts with (seeded into pipeline_stages).
const MOCK_STAGES = [
  ['L0', 'Company Sourcing', 'Initial company identification and sourcing.'],
  ['L1', 'Preliminary Review', 'First-pass review against the investment thesis.'],
  ['L2', 'Deep Dive', 'Deeper analysis of financials and market position.'],
  ['L3', 'Due Diligence', 'Full due diligence and data room review.'],
  ['L4', 'IC Review', 'Investment committee presentation and decision.'],
  ['L5', 'Closing', 'Deal closing and documentation.'],
].map(([key, name, description], position) => ({
  key,
  code: key,
  name,
  description,
  position,
  deleted: false,
}));

const mockApis = async (page: Page, companies: Company[]) => {
  await page.route('**/api/pipeline-stages**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_STAGES }) }),
  );

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

  // Supporting panels on L0 — stub with empty/no-op payloads so the page settles.
  await page.route('**/api/market-screening**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.route('**/api/screenings**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.route('**/api/investment-thesis**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
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
      await expect(page.getByRole('tab', { name: new RegExp(`^${stage} · `) })).toBeVisible();
    }

    // With no ?stage= the page opens on every stage at once.
    await expect(page.getByRole('tab', { name: 'All Stages' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('button', { name: 'Acme Corp', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wonka', exact: true })).toBeVisible();
    await expect(page.getByTestId('pipeline-pending-chip')).toBeVisible();
  });

  test('User opens the Pipeline with ?stage=L2', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L2'),
    ]);

    await expect(page.getByRole('tab', { name: 'L2 · Deep Dive' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('pipeline-stage-description')).toHaveText(
      'Description: Deeper analysis of financials and market position.',
    );
    await expect(page.getByRole('button', { name: 'Stark Industries', exact: true })).toBeVisible();
  });

  test('User switches pipeline stage tabs', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L1'),
    ]);

    await page.getByRole('tab', { name: 'L3 · Due Diligence' }).click();
    await expect(page).toHaveURL(/\/pipeline\?stage=L3/);
    await expect(page.getByRole('button', { name: 'Wayne Enterprises', exact: true })).toBeVisible();
  });

  test('User searches across every stage, including Pending Confirmation', async ({ page }) => {
    const companies = [
      ...MOCK_COMPANIES,
      baseCompany({ id: 'pending-w', target: 'Wayne Pending', source: 'inbound', pipeline_stage: 'unreviewed' }),
    ];
    await mockAuthSession(page);
    await mockApis(page, companies);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L1'),
    ]);

    await expect(page.getByRole('button', { name: 'Initech', exact: true })).toBeVisible();

    // The search looks past the L1 filter: the L3 deal and the pending one
    // are both found, and L1's own deals drop out.
    const search = page.getByPlaceholder('Search companies or sectors...');
    await search.fill('wayne');
    await expect(page.getByRole('button', { name: 'Wayne Enterprises', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wayne Pending', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Initech', exact: true })).not.toBeVisible();
    await expect(page.getByTestId('pipeline-search-scope-hint')).toBeVisible();
    await expect(page).toHaveURL(/[?&]q=wayne/);

    // The stage filter is disabled while searching, and keeps its selection.
    await expect(page.getByRole('tab', { name: 'L3 · Due Diligence' })).toBeDisabled();
    await expect(page.getByTestId('pipeline-pending-chip')).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'L1 · Preliminary Review' })).toHaveAttribute('data-state', 'active');
  });

  test('User clears a search and returns to the stage they started on', async ({ page }) => {
    await mockAuthSession(page);
    await mockApis(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L1'),
    ]);

    const search = page.getByPlaceholder('Search companies or sectors...');
    await search.fill('wayne');
    await search.fill('');
    await expect(page.getByRole('tab', { name: 'L1 · Preliminary Review' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('tab', { name: 'L3 · Due Diligence' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Initech', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wayne Enterprises', exact: true })).not.toBeVisible();
  });

  test('User sees search matches in the other source', async ({ page }) => {
    const companies = [
      ...MOCK_COMPANIES,
      baseCompany({ id: 'out-1', target: 'Wayne Outbound', source: 'outbound', pipeline_stage: 'L2' }),
    ];
    await mockAuthSession(page);
    await mockApis(page, companies);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline'),
    ]);

    await page.getByTestId('pipeline-source-select').click();
    await page.getByRole('option', { name: 'Inbound', exact: true }).click();

    await page.getByPlaceholder('Search companies or sectors...').fill('wayne');
    await expect(page.getByTestId('pipeline-other-source-hint')).toContainText('1 match in Outbound');
    await page.getByTestId('pipeline-other-source-hint').getByRole('button', { name: 'Show' }).click();
    await expect(page.getByRole('button', { name: 'Wayne Outbound', exact: true })).toBeVisible();
  });

  test('User sees inbound and outbound deals together under All Sources by default', async ({ page }) => {
    const companies = [
      ...MOCK_COMPANIES,
      baseCompany({ id: 'out-1', target: 'Cyberdyne Outbound', source: 'outbound', pipeline_stage: 'L0' }),
    ];
    await mockAuthSession(page);
    await mockApis(page, companies);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L0'),
    ]);

    await expect(page.getByTestId('pipeline-source-select')).toHaveText('All Sources');
    await expect(page.getByRole('button', { name: 'Acme Corp', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cyberdyne Outbound', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Source Type' })).toBeVisible();
    const outboundRow = page.getByRole('row').filter({ hasText: 'Cyberdyne Outbound' });
    await expect(outboundRow.getByRole('cell', { name: 'Outbound', exact: true })).toBeVisible();
    const inboundRow = page.getByRole('row').filter({ hasText: 'Acme Corp' });
    await expect(inboundRow.getByRole('cell', { name: 'Inbound', exact: true })).toBeVisible();
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

  test('User views a stage with no companies', async ({ page }) => {
    await mockAuthSession(page);
    // Only L0 data, so L4 will be empty.
    const onlyL0 = MOCK_COMPANIES.filter((c) => c.pipeline_stage === 'L0');
    await mockApis(page, onlyL0);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline?stage=L4'),
    ]);

    await expect(page.getByText('No companies match the current filters.')).toBeVisible();
  });

  test('User opens Pending Confirmation from the Pipeline', async ({ page }) => {
    const companies = [
      ...MOCK_COMPANIES,
      baseCompany({ id: 'pending-1', target: 'PT Sinar Teknologi', source: 'inbound', pipeline_stage: 'unreviewed' }),
      baseCompany({ id: 'pending-2', target: 'Dummy Pending Outbound Co', source: 'outbound', pipeline_stage: 'unreviewed' }),
    ];
    await mockAuthSession(page);
    await mockApis(page, companies);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && !res.url().includes('countOnly') && res.status() === 200),
      page.goto('/pipeline'),
    ]);

    // All Stages leaves pending deals of every source out; the chip shows them.
    await expect(page.getByRole('button', { name: 'Acme Corp', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PT Sinar Teknologi', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Dummy Pending Outbound Co', exact: true })).not.toBeVisible();
    await page.getByTestId('pipeline-pending-chip').click();
    await expect(page).toHaveURL(/\/pipeline\?stage=pending/);
    await expect(page.getByRole('button', { name: 'PT Sinar Teknologi', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dummy Pending Outbound Co', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acme Corp', exact: true })).not.toBeVisible();

    // The source filter narrows the pending bucket too.
    await page.getByTestId('pipeline-source-select').click();
    await page.getByRole('option', { name: 'Outbound', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Dummy Pending Outbound Co', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PT Sinar Teknologi', exact: true })).not.toBeVisible();
  });

  test('User triages unreviewed inbound companies on Sourcing', async ({ page }) => {
    const companies = [
      baseCompany({
        id: 'triage-1',
        target: 'PT Sinar Teknologi',
        segment: 'Technology',
        source: 'inbound',
        pipeline_stage: 'unreviewed',
        review_state: 'unreviewed',
        doc_type: 'teaser',
        banker_source: 'Goldman Sachs',
      }),
      baseCompany({
        id: 'triage-2',
        target: 'BrightStar Energy',
        segment: 'Energy',
        source: 'inbound',
        pipeline_stage: 'unreviewed',
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
      page.goto('/sourcing'),
    ]);

    // Triage lives on the Sourcing page's Pending Confirmation tab.
    await expect(page.getByTestId('sourcing-tab-pending')).toHaveAttribute('data-state', 'active');
    await expect(page.getByText('companies awaiting review')).toBeVisible();

    await page.getByRole('button', { name: 'Triage Unreviewed', exact: true }).click();
    const triageDialog = page.getByRole('dialog', { name: 'Triage Unreviewed Companies' });
    await expect(triageDialog).toBeVisible();
    // The same names also sit in the Pending Confirmation table behind the modal.
    await expect(triageDialog.getByText('PT Sinar Teknologi')).toBeVisible();
    await expect(triageDialog.getByText('Goldman Sachs')).toBeVisible();

    // `.last()` is the innermost element holding the company's name and the
    // button, i.e. that company's own row in the modal, not a wrapper around both.
    await triageDialog
      .locator('div')
      .filter({ hasText: 'PT Sinar Teknologi' })
      .filter({ has: page.getByRole('button', { name: 'Keep' }) })
      .last()
      .getByRole('button', { name: 'Keep' })
      .click();
    await triageDialog
      .locator('div')
      .filter({ hasText: 'BrightStar Energy' })
      .filter({ has: page.getByRole('button', { name: 'Drop' }) })
      .last()
      .getByRole('button', { name: 'Drop' })
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
