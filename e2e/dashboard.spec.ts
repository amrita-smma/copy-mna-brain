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

const MOCK_COMPANIES: Company[] = [
  baseCompany({ id: 'co-1', target: 'Acme Corp', pipeline_stage: 'L0', source: 'inbound', l1_screening_result: 'pass' }),
  baseCompany({ id: 'co-2', target: 'Globex', pipeline_stage: 'L0', source: 'outbound', l1_screening_result: 'pending' }),
  baseCompany({ id: 'co-3', target: 'Initech', pipeline_stage: 'L1', source: 'inbound', l1_screening_result: 'pass' }),
  baseCompany({ id: 'co-4', target: 'Umbrella', pipeline_stage: 'L1', source: 'outbound', l1_screening_result: 'fail' }),
  baseCompany({ id: 'co-5', target: 'Stark Industries', pipeline_stage: 'L2', source: 'inbound' }),
  baseCompany({ id: 'co-6', target: 'Wayne Enterprises', pipeline_stage: 'L3', source: 'outbound' }),
  baseCompany({ id: 'co-7', target: 'Tyrell', pipeline_stage: 'L4', source: 'inbound' }),
  baseCompany({ id: 'co-8', target: 'Wonka', pipeline_stage: 'L5', source: 'outbound' }),
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

test.describe('Dashboard page', () => {
  test('Unauthenticated user opens the dashboard', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user views the dashboard with companies', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
    await page.goto('/dashboard');

    // Header
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Real-time overview of your M&A deal pipeline')).toBeVisible();

    // Stat cards - totals derived from MOCK_COMPANIES (8 total, 4 inbound,
    // 4 outbound, 1/2 [L5/L0] = 50% conversion).
    const totalDeals = page.locator('div').filter({ hasText: /^Total Deals$/ }).locator('..').locator('..');
    await expect(totalDeals.getByText('8', { exact: true })).toBeVisible();

    const inbound = page.locator('div').filter({ hasText: /^Inbound$/ }).locator('..').locator('..');
    await expect(inbound.getByText('4', { exact: true })).toBeVisible();
    await expect(inbound.getByText('50% of total')).toBeVisible();

    const outbound = page.locator('div').filter({ hasText: /^Outbound$/ }).locator('..').locator('..');
    await expect(outbound.getByText('4', { exact: true })).toBeVisible();

    const conversion = page.locator('div').filter({ hasText: /^Conversion$/ }).locator('..').locator('..');
    await expect(conversion.getByText('50%', { exact: true })).toBeVisible();
    await expect(conversion.getByText('L0 → L5')).toBeVisible();

    // Pipeline stages — scope to <main> to avoid the sidebar's nav links.
    const main = page.locator('main');
    await expect(main.getByText('Pipeline Stages')).toBeVisible();
    for (const stage of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
      await expect(
        main.getByRole('link', { name: new RegExp(`\\b${stage}\\b`) }).first(),
      ).toBeVisible();
    }

    // Company Overview table
    await expect(page.getByText('Company Overview')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Company' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Rev 2024' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acme Corp' })).toBeVisible();

    // Recent Updates
    await expect(page.getByText('Recent Updates')).toBeVisible();
  });

  test('User clicks a pipeline stage link on the dashboard', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
    await page.goto('/dashboard');

    const l2Link = page
      .locator('main')
      .getByRole('link')
      .filter({ hasText: /^\d+.*L2/s })
      .first();
    const href = await l2Link.getAttribute('href');
    expect(href).toBe('/pipeline?stage=L2');
  });

  test('User pages through more than 10 companies', async ({ page }) => {
    await mockAuthSession(page);
    const many: Company[] = Array.from({ length: 12 }, (_, i) =>
      baseCompany({
        id: `co-${i + 1}`,
        target: `Company ${i + 1}`,
        pipeline_stage: 'L0',
        source: i % 2 === 0 ? 'inbound' : 'outbound',
      }),
    );
    await mockCompanies(page, many);
    await page.goto('/dashboard');

    await expect(page.getByText(/Page\s*1\s*of\s*2/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 11', exact: true })).not.toBeVisible();

    // Use evaluate-click to avoid the chatbot widget intercepting pointer
    // coordinates over the pagination controls.
    await page
      .locator('button:has(svg.lucide-chevron-right)')
      .first()
      .evaluate((el) => (el as HTMLButtonElement).click());

    await expect(page.getByText(/Page\s*2\s*of\s*2/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 11', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 12', exact: true })).toBeVisible();
  });

  test('User clicks a company row on the dashboard', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);
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

    await page.getByRole('button', { name: 'Acme Corp' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('Dashboard loads with an empty company list', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, []);

    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/companies') && res.status() === 200,
      ),
      page.goto('/dashboard'),
    ]);

    await expect(page.getByText('No companies in database yet.')).toBeVisible();
    await expect(page.getByText('No companies yet').first()).toBeVisible();
  });

  test('Dashboard data fetch is still pending', async ({ page }) => {
    await mockAuthSession(page);
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
