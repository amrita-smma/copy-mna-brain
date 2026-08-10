import { test, expect, Page } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

type FileRecord = {
  id: string;
  file_name: string;
  raw_notes: string | null;
  structured_notes: string | null;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed';
  tags: string[];
  matched_companies: Array<{ id?: string; name?: string; type?: string }>;
  signed_url?: string;
  file_date: string | null;
  created_at: string;
  updated_at: string;
};

const baseFile = (overrides: Partial<FileRecord>): FileRecord => ({
  id: 'f-0',
  file_name: 'example.pdf',
  raw_notes: null,
  structured_notes: null,
  processing_status: 'completed',
  tags: [],
  matched_companies: [],
  signed_url: undefined,
  file_date: '2026-01-15',
  created_at: '2026-01-15T00:00:00Z',
  updated_at: '2026-01-15T00:00:00Z',
  ...overrides,
});

const MOM_FILES: FileRecord[] = [
  baseFile({ id: 'mom-1', file_name: 'Board Meeting March.pdf', processing_status: 'completed', tags: ['quarterly', 'board'] }),
  baseFile({ id: 'mom-2', file_name: 'Investor Call Q1.pdf', processing_status: 'processing', tags: ['investors'] }),
];

const PROSPECTUS_FILES: FileRecord[] = [
  baseFile({ id: 'pro-1', file_name: 'Acme Prospectus.pdf', processing_status: 'completed' }),
];

const BANKER_FILES: FileRecord[] = [
  baseFile({ id: 'bnk-1', file_name: 'Goldman Engagement Letter.pdf', processing_status: 'completed' }),
];

const OTHER_FILES: FileRecord[] = [
  baseFile({ id: 'oth-1', file_name: 'Misc Notes.pdf', processing_status: 'pending' }),
];

const fulfillList = (route: { fulfill: (r: object) => Promise<void> }, data: FileRecord[]) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data, total: data.length }),
  });

/**
 * /api/smart-files is dispatched by the `file_type` query param:
 *   ?file_type                      → MoM (empty value ⇒ default list)
 *   ?file_type=prospectus           → Prospectus
 *   ?file_type=banker_communications → Banker Communications
 *   ?file_type=other                → Other
 */
const mockSmartFiles = (
  page: Page,
  opts?: { mom?: FileRecord[]; prospectus?: FileRecord[]; banker?: FileRecord[]; other?: FileRecord[] },
) => {
  const mom = opts?.mom ?? MOM_FILES;
  const prospectus = opts?.prospectus ?? PROSPECTUS_FILES;
  const banker = opts?.banker ?? BANKER_FILES;
  const other = opts?.other ?? OTHER_FILES;

  return page.route('**/api/smart-files**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();

    // Counts endpoint for tab badges
    if (method === 'GET' && url.pathname === '/api/smart-files/counts') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          counts: {
            mom: mom.length,
            prospectus: prospectus.length,
            shopping_list: 0,
            banker_communications: banker.length,
            fund_updates: 0,
            market_study: 0,
            other: other.length,
          },
        }),
      });
    }

    // Delete endpoint: /api/smart-files/<id>
    if (method === 'DELETE' && /\/api\/smart-files\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }

    if (method === 'GET' && url.pathname === '/api/smart-files') {
      const fileType = url.searchParams.get('file_type');
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const filter = (rows: FileRecord[]) =>
        search
          ? rows.filter(
              (r) =>
                r.file_name.toLowerCase().includes(search) ||
                r.tags.some((t) => t.toLowerCase().includes(search)),
            )
          : rows;

      if (fileType === 'prospectus') return fulfillList(route, filter(prospectus));
      if (fileType === 'banker_communications') return fulfillList(route, filter(banker));
      if (fileType === 'other') return fulfillList(route, filter(other));
      if (fileType === 'shopping_list' || fileType === 'fund_updates' || fileType === 'market_study') {
        return fulfillList(route, []);
      }
      // Default (MoM) – the empty-value `?file_type` sentinel.
      return fulfillList(route, filter(mom));
    }

    return route.fallback();
  });
};

test.describe('Smart Files page', () => {
  test('Unauthenticated user opens Smart Files', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/smart-files');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user views Smart Files', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    await expect(page).toHaveURL(/\/smart-files\/mom/);
    await expect(page.getByRole('heading', { name: 'Smart Files', level: 1 })).toBeVisible();
    await expect(page.getByText('Drop your files and let AI automatically organize and categorize them')).toBeVisible();

    // Upload zone — the CardTitle uses h3, the inner hint is a <p>. Use a heading
    // locator so we don't match both.
    await expect(page.getByRole('heading', { name: 'Drag and drop files' })).toBeVisible();
    await expect(page.getByText(/Drag and drop files here/)).toBeVisible();

    // Category tabs (lazy — only the active MoM table's rows are mounted)
    await expect(page.getByRole('tab', { name: /MoM/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Prospectus/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Banker Communications/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Other/ })).toBeVisible();

    await expect(page.getByText('Board Meeting March.pdf')).toBeVisible();
  });

  test('Deep link opens Prospectus tab', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          res.url().includes('file_type=prospectus') &&
          res.status() === 200,
      ),
      page.goto('/smart-files/prospectus'),
    ]);

    await expect(page).toHaveURL(/\/smart-files\/prospectus/);
    await expect(page.getByRole('tab', { name: /Prospectus/ })).toHaveAttribute('data-state', 'active');
    await expect(page.getByText('Acme Prospectus.pdf')).toBeVisible();
  });

  test('Switching tabs updates the path', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files/mom'),
    ]);

    await page.getByRole('tab', { name: /Prospectus/ }).click();
    await expect(page).toHaveURL(/\/smart-files\/prospectus/);
    await expect(page.getByText('Acme Prospectus.pdf')).toBeVisible();
  });

  test('Empty MoM tab shows empty state', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page, { mom: [], prospectus: [], banker: [], other: [] });

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    await expect(page.getByText('No MoM uploaded yet.')).toBeVisible();
  });

  test('Smart Files fetches are still pending', async ({ page }) => {
    await mockAuthSession(page);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    await page.route('**/api/smart-files**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/smart-files/counts') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, counts: {} }),
        });
      }
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [], total: 0 }),
      });
    });

    await page.goto('/smart-files');

    // While fetches are gated the main header hasn't rendered yet.
    await expect(page.getByRole('heading', { name: 'Smart Files', level: 1 })).not.toBeVisible();

    release();
    await expect(page.getByRole('heading', { name: 'Smart Files', level: 1 })).toBeVisible();
  });

  test('User selects a file via the browse input', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'new-report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('hello world'),
    });

    await expect(page.getByText('Selected Files (1)')).toBeVisible();
    await expect(page.getByText('new-report.pdf', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Upload File/ })).toBeVisible();
  });

  test('User selects a file matching an existing name', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    // Upload a file whose name matches an existing MoM entry.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'Board Meeting March.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('dup'),
    });

    await expect(page.getByText('Duplicate').first()).toBeVisible();
  });

  test('User clears the selection', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'alpha.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('a'),
    });
    await expect(page.getByText('Selected Files (1)')).toBeVisible();

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.getByText('Selected Files (1)')).not.toBeVisible();
  });

  test('User searches the MoM table', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          res.url().includes('search=Board') &&
          res.status() === 200,
      ),
      page.getByPlaceholder('Search across all file types...').fill('Board'),
    ]);

    await expect(page.getByText('Board Meeting March.pdf')).toBeVisible();
    await expect(page.getByText('Investor Call Q1.pdf')).not.toBeVisible();
  });

  test('User deletes a file', async ({ page }) => {
    await mockAuthSession(page);
    await mockSmartFiles(page);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/smart-files') &&
          !res.url().includes('/counts') &&
          res.status() === 200,
      ),
      page.goto('/smart-files'),
    ]);

    const row = page.getByRole('row').filter({ hasText: 'Board Meeting March.pdf' });
    // The delete button is the only one with text-destructive styling in the row.
    await row.locator('button.text-destructive').click();

    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('Board Meeting March.pdf')).toBeVisible();

    const [deleteReq] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/api/smart-files/')),
      confirm.getByRole('button', { name: 'Delete', exact: true }).click(),
    ]);
    expect(deleteReq.url()).toContain('/api/smart-files/mom-1');
  });
});
