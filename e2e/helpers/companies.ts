import type { Page } from '@playwright/test';

/**
 * The flat, FE-facing company shape the Master Data page renders. Mirrors the
 * subset of `CompanyDTO` the table reads. Used both as intercept fixtures and
 * as the payload for real API inserts.
 */
export type Company = {
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

export const baseCompany = (overrides: Partial<Company>): Company => ({
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

/**
 * `mock` — intercept `/api/companies` and serve the fixtures verbatim (offline,
 * deterministic). `real` — POST the fixtures to the real API so they actually
 * exist in the target DB, then read them back through the live endpoint.
 *
 * Selected by `E2E_DATA_MODE` (defaults to `mock`). Kept independent of
 * `TEST_ENV` so a real-data run can target local just as easily as staging.
 */
export type DataMode = 'mock' | 'real';

export const getDataMode = (): DataMode =>
  process.env.E2E_DATA_MODE === 'real' ? 'real' : 'mock';

export interface ProvisionedCompanies {
  /**
   * Companies as they appear in the UI. In `real` mode these carry the
   * server-assigned `id` and a marker-suffixed `target`; in `mock` mode they
   * are the fixtures unchanged.
   */
  companies: Company[];
  /**
   * Unique token that scopes the seeded rows in `real` mode — type it into the
   * search box to filter the (shared, real) table down to exactly this set.
   * Empty string in `mock` mode, where the table only ever holds the fixtures.
   */
  marker: string;
  /** Delete every row this provisioning created. No-op in `mock` mode. */
  cleanup: () => Promise<void>;
}

const COMPANIES_GLOB = '**/api/companies**';

/**
 * Intercept all `/api/companies` traffic and answer from the in-memory
 * `companies` array — list, single-by-id, and delete. Anything else falls
 * through to the network.
 */
const interceptCompanies = (page: Page, companies: Company[]) =>
  page.route(COMPANIES_GLOB, (route) => {
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

/**
 * Create each fixture in the real DB via `POST /api/companies` (authenticated
 * by the session cookie a prior real `signIn` set on the page's context).
 *
 * The fixture `target` is suffixed with a per-run marker so the rows can be
 * isolated from whatever else lives in the target environment. Inserts run in
 * reverse so the first fixture is created last — `created_at DESC` (the page's
 * sort) then surfaces the fixtures in the same order the array lists them,
 * matching `mock` mode.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST one company, retrying transient failures. A shared target environment
 * (staging) can return 5xx (e.g. brief DB connection contention) or drop the
 * socket (`ECONNRESET`) under parallel test load; neither is deterministic, so
 * a bounded retry with linear backoff keeps the seeding resilient without
 * masking a genuine, persistent error (which still throws after the last try).
 */
const postCompanyWithRetry = async (
  page: Page,
  target: string,
  company: Record<string, unknown>,
): Promise<{ id: string; created_at: string; updated_at: string }> => {
  const MAX_ATTEMPTS = 4;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await page.request.post('/api/companies', {
        data: { company, logAction: 'CREATED' },
      });
      if (res.ok()) {
        const { data } = (await res.json()) as {
          data: { id: string; created_at: string; updated_at: string };
        };
        return data;
      }
      lastError = `${res.status()}: ${await res.text()}`;
      // Only 5xx is worth retrying; a 4xx is a real client error (bad payload,
      // auth) that will never succeed on retry, so fail fast.
      if (res.status() < 500) break;
    } catch (err) {
      // Network-level failure (e.g. ECONNRESET) — treat as transient.
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 500);
  }

  throw new Error(
    `Failed to seed company "${target}" after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
};

const seedCompaniesViaApi = async (
  page: Page,
  companies: Company[],
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<ProvisionedCompanies> => {
  const marker = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const seeded: Company[] = new Array(companies.length);

  const cleanup = async () => {
    // Marker-scoped teardown: collect the ids we captured *and* re-query the
    // API for any row whose target carries this run's marker. A POST that
    // inserted the row but failed on the post-insert read leaves an orphan we
    // never got an id for; the marker query catches it so nothing leaks into
    // the shared environment.
    const ids = new Set(seeded.filter((c) => c?.id).map((c) => c.id));
    try {
      const res = await page.request.get(
        `/api/companies?lite=true&q=${encodeURIComponent(marker)}&limit=100`,
      );
      if (res.ok()) {
        const { data } = (await res.json()) as { data: Array<{ id: string }> };
        for (const row of data ?? []) if (row?.id) ids.add(row.id);
      }
    } catch {
      // Fall back to the captured ids if the lookup itself fails.
    }
    for (const id of ids) {
      try {
        await page.request.delete(`/api/companies?id=${encodeURIComponent(id)}`);
      } catch {
        // Best-effort teardown — a row deleted by the test itself is fine.
      }
    }
  };

  // Register cleanup *before* the first insert so a partial-seed failure (some
  // rows created, then a POST throws) is still torn down — `cleanup`'s marker
  // query finds every row this run created, even the ones inserted before the
  // throw. Registering after the loop would leak those rows on failure.
  registerCleanup?.(cleanup);

  for (let i = companies.length - 1; i >= 0; i--) {
    const input = companies[i];
    const target = `${input.target ?? 'Company'} ${marker}`;
    // Strip server-owned fields; let the API assign id/timestamps.
    const company: Record<string, unknown> = { ...input, target };
    delete company.id;
    delete company.created_at;
    delete company.updated_at;

    const data = await postCompanyWithRetry(page, target, company);
    seeded[i] = { ...input, target, id: data.id, created_at: data.created_at, updated_at: data.updated_at };
  }

  return { companies: seeded, marker, cleanup };
};

/**
 * Make `companies` available to the Master Data page, in whichever way the
 * current `E2E_DATA_MODE` dictates. Always call this *after* a real `signIn`
 * (real mode needs the session cookie to POST) and *before* navigating.
 *
 * Pass `registerCleanup` (e.g. `(c) => cleanups.push(c)`) so teardown is wired
 * up *before* any insert runs — that way a partial-seed failure still gets torn
 * down. The same function is also returned as `cleanup` for explicit calls.
 */
export const provisionCompanies = async (
  page: Page,
  companies: Company[],
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<ProvisionedCompanies> => {
  if (getDataMode() === 'real') {
    return seedCompaniesViaApi(page, companies, registerCleanup);
  }
  await interceptCompanies(page, companies);
  return { companies, marker: '', cleanup: async () => {} };
};
