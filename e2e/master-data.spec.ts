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
  remarks: string | null;
  created_at: string;
  updated_at: string;
};

const baseCompany = (overrides: Partial<Company>): Company => ({
  id: 'co-0',
  target: 'Acme Corp',
  segment: 'Technology',
  website: null,
  watchlist_status: 'Active',
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
  baseCompany({ id: 'co-1', target: 'Acme Corp', segment: 'Technology', pipeline_stage: 'L0', watchlist_status: 'Active' }),
  baseCompany({ id: 'co-2', target: 'Globex', segment: 'Finance', pipeline_stage: 'L1', watchlist_status: 'Inactive' }),
  baseCompany({ id: 'co-3', target: 'Initech', segment: 'Technology', pipeline_stage: 'L2', watchlist_status: 'Active' }),
  baseCompany({ id: 'co-4', target: 'Umbrella', segment: 'Healthcare', pipeline_stage: 'L3', watchlist_status: 'Inactive' }),
  baseCompany({ id: 'co-5', target: 'Stark Industries', segment: 'Manufacturing', pipeline_stage: 'L5', watchlist_status: 'Active' }),
];

const mockCompanies = (page: Page, companies: Company[]) =>
  page.route('**/api/companies**', (route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());

    if (method === 'GET') {
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

    if (method === 'DELETE') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { success: true } }),
      });
    }

    return route.fallback();
  });

test.describe('Master Data page', () => {
  test('Unauthenticated user opens Master Data', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/master-data');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user views Master Data', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    await expect(page.getByRole('heading', { name: 'Master Data', level: 1 })).toBeVisible();
    await expect(page.getByText('Complete overview of all companies in the system')).toBeVisible();

    await expect(page.getByText(`All Companies (${MOCK_COMPANIES.length})`)).toBeVisible();

    for (const name of ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Stark Industries']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }

    // Per-stage badges (L0: 1, L1: 1, ... L5: 1, L4: 0)
    await expect(page.getByText('L0: 1')).toBeVisible();
    await expect(page.getByText('L4: 0')).toBeVisible();
    await expect(page.getByText('L5: 1')).toBeVisible();
  });

  test('User searches by company name', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    await page.getByPlaceholder('Search companies or sectors...').fill('globex');

    await expect(page.getByRole('button', { name: 'Globex', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acme Corp', exact: true })).not.toBeVisible();
    await expect(page.getByText('All Companies (1)')).toBeVisible();
  });

  test('User filters by Source = Inbound', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    // Only watchlist_status === 'Active' maps to inbound (co-1, co-3, co-5).
    await page.getByRole('combobox').filter({ hasText: /Source|All Sources/ }).click();
    await page.getByRole('option', { name: 'Inbound' }).click();

    await expect(page.getByText('All Companies (3)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acme Corp', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Globex', exact: true })).not.toBeVisible();
  });

  test('User filters by stage L3', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    await page.getByRole('combobox').filter({ hasText: /Stage|All Stages/ }).click();
    await page.getByRole('option', { name: 'L3 - Due Diligence' }).click();

    await expect(page.getByText('All Companies (1)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Umbrella', exact: true })).toBeVisible();
  });

  test('User clicks a suggestion chip', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    const firstChip = page.locator('button.text-primary').first();
    const chipText = (await firstChip.textContent())?.replace(/^"|"$/g, '') ?? '';
    await firstChip.click();

    const search = page.getByPlaceholder('Search companies or sectors...');
    await expect(search).toHaveValue(chipText);
  });

  test('User pages through more than 10 companies', async ({ page }) => {
    await mockAuthSession(page);
    const many: Company[] = Array.from({ length: 12 }, (_, i) =>
      baseCompany({
        id: `co-${i + 1}`,
        target: `Company ${i + 1}`,
        segment: 'Technology',
        pipeline_stage: 'L0',
        watchlist_status: 'Active',
      }),
    );
    await mockCompanies(page, many);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    await expect(page.getByText(/Page\s*1\s*of\s*2\s*\(12 companies\)/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 11', exact: true })).not.toBeVisible();

    // ChatbotWidget (fixed bottom-right) sits over the pagination button, so dispatch
    // the click directly on the DOM node instead of via pointer coordinates.
    await page.locator('button:has(svg.lucide-chevron-right)').evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByText(/Page\s*2\s*of\s*2/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Company 11', exact: true })).toBeVisible();
  });

  test('User clicks a company row in Master Data', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    // Supporting endpoints the dialog may hit – return empty arrays.
    await page.route('**/api/deal-notes**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );
    await page.route('**/api/deal-links**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );
    await page.route('**/api/deal-documents**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );

    await page.getByRole('button', { name: 'Acme Corp', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('User deletes a company', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    const globexRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Globex', exact: true }) });
    await globexRow.getByRole('button').last().click();

    const confirmDialog = page.getByRole('alertdialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText('Globex')).toBeVisible();

    const [deleteReq] = await Promise.all([
      page.waitForRequest((req) => req.method() === 'DELETE' && req.url().includes('/api/companies')),
      confirmDialog.getByRole('button', { name: 'Delete' }).click(),
    ]);
    expect(deleteReq.url()).toContain('id=co-2');

    await expect(page.getByRole('button', { name: 'Globex', exact: true })).not.toBeVisible();
    await expect(page.getByText(`All Companies (${MOCK_COMPANIES.length - 1})`)).toBeVisible();
  });

  test('User searches for a non-existent company', async ({ page }) => {
    await mockAuthSession(page);
    await mockCompanies(page, MOCK_COMPANIES);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/companies') && res.status() === 200),
      page.goto('/master-data'),
    ]);

    await page.getByPlaceholder('Search companies or sectors...').fill('no-such-company');
    await expect(page.getByText('No companies found matching your filters.')).toBeVisible();
  });
});
