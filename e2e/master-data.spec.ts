import { test, expect, Page } from '@playwright/test';
import { signIn } from './helpers/auth';
import { collapseCopilot } from './helpers/layout';
import {
  baseCompany,
  getDataMode,
  provisionCompanies,
  type Company,
  type ProvisionedCompanies,
} from './helpers/companies';

// REG-MD-04: 3 inbound (co-1, co-3, co-5, co-6) and 2 outbound (co-2, co-4).
// co-6 is a Chinese-character company to cover REG-MD-02 (Unicode rendering)
// and REG-MD-03 (Chinese-character search).
const MOCK_COMPANIES: Company[] = [
  baseCompany({ id: 'co-1', target: 'Acme Corp', segment: 'Technology', pipeline_stage: 'L0', source: 'inbound' }),
  baseCompany({ id: 'co-2', target: 'Globex', segment: 'Finance', pipeline_stage: 'L1', source: 'outbound' }),
  baseCompany({ id: 'co-3', target: 'Initech', segment: 'Technology', pipeline_stage: 'L2', source: 'inbound' }),
  baseCompany({ id: 'co-4', target: 'Umbrella', segment: 'Healthcare', pipeline_stage: 'L3', source: 'outbound' }),
  baseCompany({ id: 'co-5', target: 'Stark Industries', segment: 'Manufacturing', pipeline_stage: 'L5', source: 'inbound' }),
  baseCompany({ id: 'co-6', target: '凤凰纸业（贵港）有限公司', segment: 'Manufacturing', pipeline_stage: 'L1', source: 'inbound' }),
];

const SEARCH = 'Search companies or sectors...';

test.describe('Master Data page', () => {
  // Track real-mode inserts so each test cleans up after itself.
  const cleanups: Array<() => Promise<void>> = [];
  test.afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /**
   * Real sign-in, provision companies for the current data mode, navigate to
   * the page and wait for the company list to load. Returns the provisioned
   * set so tests can assert against the right ids/targets and scope to the
   * seeded rows in real mode.
   */
  const openMasterData = async (
    page: Page,
    companies: Company[] = MOCK_COMPANIES,
  ): Promise<ProvisionedCompanies> => {
    // Keep the AI CoPilot pane collapsed; expanded, it hides the page content.
    await collapseCopilot(page);
    await signIn(page);
    const provisioned = await provisionCompanies(page, companies, (c) => cleanups.push(c));

    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/companies') && res.request().method() === 'GET' && res.status() === 200,
      ),
      page.goto('/master-data'),
    ]);
    return provisioned;
  };

  /**
   * In real mode the table is shared with the rest of the target environment,
   * so narrow it to just the seeded rows by typing the run marker into the
   * search box. No-op in mock mode (the table only holds the fixtures).
   */
  const scopeToSeeded = async (page: Page, marker: string) => {
    if (marker) await page.getByPlaceholder(SEARCH).fill(marker);
  };

  /** Extract the numeric count from the "All Companies (N)" heading. */
  const getDisplayedCount = async (page: Page): Promise<number> => {
    const text = await page.getByText(/All Companies \(\d+\)/).textContent();
    return parseInt(text!.match(/\d+/)![0]);
  };

  // REG-MD-01
  test('Unauthenticated user opens Master Data', async ({ page }) => {
    // A fresh context has no session cookie, so the page should bounce to login.
    await page.goto('/master-data');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  // REG-MD-02
  test('Authenticated user views Master Data', async ({ page }) => {
    const { companies, marker, cleanup } = await openMasterData(page);

    await expect(page.getByRole('heading', { name: 'Master Data', level: 1 })).toBeVisible();
    await expect(page.getByText('Complete overview of all companies in the system')).toBeVisible();

    await scopeToSeeded(page, marker);

    // Count must be at least the number of seeded companies (>= 5).
    const count = await getDisplayedCount(page);
    expect(count).toBeGreaterThanOrEqual(5);

    // All seeded companies must render — including the Chinese-character one.
    for (const company of companies) {
      await expect(page.getByRole('button', { name: company.target!, exact: true })).toBeVisible();
    }

    await cleanup();
  });

  // REG-MD-03
  test('User searches by company name', async ({ page }) => {
    const { companies, cleanup } = await openMasterData(page);
    const [, globex,,,,chinese] = companies;

    // --- English search ---
    await page.getByPlaceholder(SEARCH).fill(globex.target!);

    const englishCount = await getDisplayedCount(page);
    expect(englishCount).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: globex.target!, exact: true })).toBeVisible();

    // --- Chinese-character search ---
    // Search using a substring of the Chinese company name that is unique to it.
    const chineseSearchTerm = getDataMode() === 'real' ? chinese.target! : '凤凰';
    await page.getByPlaceholder(SEARCH).fill(chineseSearchTerm);

    const chineseCount = await getDisplayedCount(page);
    expect(chineseCount).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: chinese.target!, exact: true })).toBeVisible();

    await cleanup();
  });

  // REG-MD-04
  test('User filters by Source = Inbound', async ({ page }) => {
    const { companies, marker, cleanup } = await openMasterData(page);
    const [acme, globex] = companies;

    await scopeToSeeded(page, marker);

    await page.getByRole('combobox').filter({ hasText: /Source|All Sources/ }).click();
    await page.getByRole('option', { name: 'Inbound' }).click();

    // Count must be > 0 and every visible row must be inbound.
    const count = await getDisplayedCount(page);
    expect(count).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: acme.target!, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: globex.target!, exact: true })).not.toBeVisible();

    await cleanup();
  });

  // REG-MD-05
  test('User filters by stage L3', async ({ page }) => {
    const { companies, marker, cleanup } = await openMasterData(page);
    const umbrella = companies[3];

    await scopeToSeeded(page, marker);

    await page.getByRole('combobox').filter({ hasText: /Stage|All Stages/ }).click();
    await page.getByRole('option', { name: 'L3 - Due Diligence' }).click();

    // Count must be > 0 and the expected L3 company must be visible.
    const count = await getDisplayedCount(page);
    expect(count).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: umbrella.target!, exact: true })).toBeVisible();

    await cleanup();
  });

  // REG-MD-06
  test('User clicks a suggestion chip', async ({ page }) => {
    const { cleanup } = await openMasterData(page);

    const firstChip = page.locator('button.text-primary').first();
    const chipText = (await firstChip.textContent())?.replace(/^"|"$/g, '') ?? '';
    await firstChip.click();

    // Search field must be populated with the chip's text.
    const search = page.getByPlaceholder(SEARCH);
    await expect(search).toHaveValue(chipText);

    // If any companies are shown, every visible row must contain the chip text
    // in its company name OR its sector — the list filter matches on either
    // (see MasterData `matchesSearch`), so checking the name alone is wrong.
    const count = await getDisplayedCount(page);
    if (count > 0) {
      const needle = chipText.toLowerCase();
      const rows = page
        .getByRole('row')
        .filter({ has: page.locator('td:first-child button') });
      const numRows = await rows.count();
      for (let i = 0; i < numRows; i++) {
        const row = rows.nth(i);
        const name = (await row.locator('td:first-child button').textContent()) ?? '';
        // Sector is the 4th column (Company, Project, Status, Sector).
        const sector = (await row.locator('td:nth-child(4)').textContent()) ?? '';
        expect(
          name.toLowerCase().includes(needle) || sector.toLowerCase().includes(needle),
          `Row "${name.trim()}" (sector "${sector.trim()}") should contain "${chipText}" in its name or sector`,
        ).toBe(true);
      }
    }

    await cleanup();
  });

  // REG-MD-07
  test('User pages through more than 10 companies', async ({ page }) => {
    const many: Company[] = Array.from({ length: 12 }, (_, i) =>
      baseCompany({
        id: `co-${i + 1}`,
        target: `Company ${i + 1}`,
        segment: 'Technology',
        pipeline_stage: 'L0',
        watchlist_status: 'Active',
      }),
    );
    const { companies, marker, cleanup } = await openMasterData(page, many);

    await scopeToSeeded(page, marker);

    await expect(page.getByText(/Page\s*1\s*of\s*2\s*\(12 companies\)/)).toBeVisible();
    await expect(page.getByRole('button', { name: companies[0].target!, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: companies[10].target!, exact: true })).not.toBeVisible();

    // ChatbotWidget (fixed bottom-right) sits over the pagination button, so dispatch
    // the click directly on the DOM node instead of via pointer coordinates.
    await page.locator('button:has(svg.lucide-chevron-right)').evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByText(/Page\s*2\s*of\s*2/)).toBeVisible();
    await expect(page.getByRole('button', { name: companies[10].target!, exact: true })).toBeVisible();

    await cleanup();
  });

  // REG-MD-08
  test('User clicks a company row in Master Data', async ({ page }) => {
    const { companies, marker, cleanup } = await openMasterData(page);
    const acme = companies[0];

    await scopeToSeeded(page, marker);

    // In mock mode the dialog's supporting endpoints have no backing fixtures,
    // so stub them empty. In real mode they hit the live API and return real data.
    if (getDataMode() === 'mock') {
      await page.route('**/api/deal-notes**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
      );
      await page.route('**/api/deal-links**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
      );
      await page.route('**/api/deal-documents**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
      );
    }

    await page.getByRole('button', { name: acme.target!, exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // DialogTitle renders company.target — verify the right company opened.
    await expect(dialog.getByRole('heading', { name: acme.target! })).toBeVisible();

    await cleanup();
  });

  // REG-MD-09
  test('User deletes a company', async ({ page }) => {
    const { companies, marker, cleanup } = await openMasterData(page);
    const globex = companies[1];

    await scopeToSeeded(page, marker);

    const globexRow = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: globex.target!, exact: true }) });
    await globexRow.getByRole('button').last().click();

    const confirmDialog = page.getByRole('alertdialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText(globex.target!)).toBeVisible();

    const [deleteReq] = await Promise.all([
      page.waitForRequest((req) => req.method() === 'DELETE' && req.url().includes('/api/companies')),
      confirmDialog.getByRole('button', { name: 'Delete' }).click(),
    ]);
    expect(deleteReq.url()).toContain(`id=${globex.id}`);

    await expect(page.getByRole('button', { name: globex.target!, exact: true })).not.toBeVisible();
    await expect(page.getByText(`All Companies (${companies.length - 1})`)).toBeVisible();

    // Globex was already deleted via the UI; cleanup removes the remaining seeded rows.
    await cleanup();
  });

  // REG-MD-10
  test('User searches for a non-existent company', async ({ page }) => {
    const { cleanup } = await openMasterData(page);

    await page.getByPlaceholder(SEARCH).fill('no-such-company');
    await expect(page.getByText('No companies found matching your filters.')).toBeVisible();

    await cleanup();
  });
});
