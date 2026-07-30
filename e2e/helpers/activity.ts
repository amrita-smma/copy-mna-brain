import type { Page } from '@playwright/test';
import { getDataMode, type Company } from './companies';

// ─── Seed-mode activity builder ───────────────────────────────────────────────

/**
 * Derive a deterministic activity payload from a set of provisioned companies.
 * Used in seed mode so the dashboard gets a synthetic-but-plausible activity
 * fixture built from the real seed company IDs — the first two (inbound) appear
 * as new L0 deals; the last two (outbound) as L0→L1 moves with the first of
 * them also appearing as a drop.
 */
export const buildActivityFromProvisioned = (companies: Company[]): ActivityPayload => {
  const inbound = companies.filter((c) => c.source === 'inbound');
  const outbound = companies.filter((c) => c.source === 'outbound');

  return {
    newL0Companies: inbound.map((c, i) => ({
      id: c.id,
      target: c.target,
      project_name: null,
      source: c.source,
      segment: c.segment,
      geography: null,
      remarks: null,
      thesis_content: null,
      event_at: new Date(Date.UTC(2026, 5, 12, 10 - i, 0, 0)).toISOString(),
      reason: 'created' as const,
    })),
    aiSourcedCompanies: [],
    discoveredCompanies: [],
    pipelineMoves: outbound.map((c, i) => ({
      id: `log-seed-${i + 1}`,
      company_id: c.id,
      action: 'PROMOTED_TO_L1',
      created_at: new Date(Date.UTC(2026, 5, 16, 10 + i, 0, 0)).toISOString(),
      target: c.target,
      project_name: null,
      segment: c.segment,
      geography: null,
      source: c.source,
      remarks: null,
      thesis_content: null,
    })),
    slidesGenerated: [],
    droppedDeals: outbound.slice(0, 1).map((c) => ({
      id: c.id,
      target: c.target,
      project_name: null,
      pipeline_stage: 'L1',
      dropped_at: new Date(Date.UTC(2026, 5, 16, 12, 0, 0)).toISOString(),
      dropped_reason: null,
      segment: c.segment,
      geography: null,
      source: c.source,
      thesis_content: null,
    })),
    workforceJobs: [],
    newContacts: [],
    notesUpdated: [],
  };
};

/**
 * Dashboard activity + feed provisioning, mirroring `provisionCompanies`.
 *
 * `mock` — intercept `/api/dashboard/activity` and `/api/dashboard/feed` and
 * serve deterministic fixtures verbatim (offline, exact counts).
 * `real`  — replay the equivalent business operations against the live API
 * (promote / drop / add-note) on the already-seeded companies so the real
 * activity + feed endpoints derive the same events from the database.
 *
 * The underlying rows (company_logs, deal_notes, dropped state) are all tied to
 * the seeded companies, so the company teardown returned by `provisionCompanies`
 * removes them too — no separate cleanup is needed here.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type ActivityPayload = {
  newL0Companies: unknown[];
  aiSourcedCompanies: unknown[];
  // The dashboard iterates `discoveredCompanies` unconditionally (for...of), so
  // it must always be present — omitting it throws "is not iterable" and trips
  // the global-error boundary ("This page couldn't load").
  discoveredCompanies: unknown[];
  pipelineMoves: unknown[];
  slidesGenerated: unknown[];
  droppedDeals: unknown[];
  workforceJobs: unknown[];
  newContacts: unknown[];
  notesUpdated: unknown[];
};

export type FeedEvent = {
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

/** The `/api/dashboard/pulse` payload — the daily pipeline pulse as the Analyst
 * agent's markdown, shown in the card as-is. */
export type PulseFixture = {
  date: string;
  dateLabel: string;
  content: string;
  generatedAt: string;
};

/** Promote the company at `index` (in the provisioned array) from `from`→`to`. */
export type StageMoveOp = { index: number; from?: string; to: string };
/** Drop the company at `index`, recording the stage it was dropped at. */
export type DropOp = { index: number; stage?: string; reason?: string };
/** Add a deal note to the company at `index`. */
export type NoteOp = { index: number; content: string; stage?: string };

export interface ActivityOps {
  moves?: StageMoveOp[];
  drops?: DropOp[];
  notes?: NoteOp[];
}

export interface MockActivityFixtures {
  activity: ActivityPayload;
  /** Optional paginated feed fixture (mobile infinite-scroll path). */
  feed?: FeedEvent[];
  /** Optional "Today's Recap" pulse fixture; defaults to {@link DEFAULT_PULSE}. */
  pulse?: PulseFixture;
}

/** Deterministic "Today's Recap" fixture. The pulse involves an LLM call and a
 * daily cache server-side, so it is always mocked in e2e (both data modes) to
 * keep the card render deterministic and offline. */
export const DEFAULT_PULSE: PulseFixture = {
  date: '2026-06-18',
  dateLabel: 'Jun 18, 2026',
  content: [
    '**Today: 4 adds (+1 vs yesterday), 75% pass, outbound holding at 50%.**',
    '',
    '**Scoreboard**',
    '- Deals added: 4 vs 3 (↑)',
    '- Pass rate: 75% vs 70% (↑)',
    '- Outbound share: 50% vs 40% (↑)',
    '',
    '**Commentary**',
    'Steady day, nothing slipping.',
    '',
    '**Flags**',
    'No exceptions today.',
    '',
    '**Open actions**',
    'None.',
  ].join('\n'),
  generatedAt: '2026-06-18T00:00:00.000Z',
};

// ─── Mock-mode route interceptors ────────────────────────────────────────────

export const mockActivity = (page: Page, activity: ActivityPayload) =>
  page.route('**/api/dashboard/activity**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: activity }),
    });
  });

export const mockPulse = (page: Page, pulse: PulseFixture) =>
  page.route('**/api/dashboard/pulse**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: pulse }),
    });
  });

export const mockFeed = (page: Page, events: FeedEvent[]) =>
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

// ─── Real-mode seeding (via the live API) ────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST a mutation to the live API, retrying transient 5xx / network failures.
 * Same resilience contract as `postCompanyWithRetry` in `companies.ts`: a
 * shared target environment can briefly 5xx or drop the socket under parallel
 * load, but a 4xx is a real client error and fails fast.
 */
const postWithRetry = async (
  page: Page,
  url: string,
  data: Record<string, unknown>,
  label: string,
): Promise<void> => {
  const MAX_ATTEMPTS = 4;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await page.request.post(url, { data });
      if (res.ok()) return;
      lastError = `${res.status()}: ${await res.text()}`;
      if (res.status() < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 500);
  }

  throw new Error(`Failed to seed ${label} after ${MAX_ATTEMPTS} attempts: ${lastError}`);
};

const promoteCompany = (page: Page, id: string, from: string | undefined, to: string) =>
  postWithRetry(page, `/api/companies/${id}/promote`, { currentStage: from, nextStage: to }, `promote ${id}→${to}`);

const dropCompany = (page: Page, id: string, stage: string | undefined, reason?: string) =>
  postWithRetry(page, `/api/companies/${id}/drop`, { currentStage: stage, reason }, `drop ${id}`);

const addNote = (page: Page, id: string, content: string, stage?: string) =>
  postWithRetry(page, `/api/companies/${id}/notes`, { content, stage }, `note ${id}`);

/**
 * Make the dashboard activity + feed available to the page in whichever way the
 * current `E2E_DATA_MODE` dictates.
 *
 * In `real` mode, `companies` must be the *provisioned* set returned by
 * `provisionCompanies` (carrying server-assigned ids), and the ops are replayed
 * in dependency order — promotions before drops, so a company that is moved and
 * then dropped is still writable when the drop runs.
 *
 * In `mock` mode the live ids don't matter; the activity + feed endpoints are
 * intercepted with the supplied fixtures.
 *
 * Call this *after* `provisionCompanies` and *before* navigating.
 */
export const provisionActivity = async (
  page: Page,
  companies: Company[],
  ops: ActivityOps,
  fixtures: MockActivityFixtures,
): Promise<void> => {
  // The "Today's Recap" pulse is LLM-backed and cached server-side, so it is
  // always mocked (all modes) to keep the card deterministic and avoid a real
  // model call during e2e.
  await mockPulse(page, fixtures.pulse ?? DEFAULT_PULSE);

  const mode = getDataMode();

  if (mode === 'real') {
    for (const m of ops.moves ?? []) {
      await promoteCompany(page, companies[m.index].id, m.from, m.to);
    }
    for (const d of ops.drops ?? []) {
      await dropCompany(page, companies[d.index].id, d.stage, d.reason);
    }
    for (const n of ops.notes ?? []) {
      await addNote(page, companies[n.index].id, n.content, n.stage);
    }
    return;
  }

  if (mode === 'seed') {
    // Build a synthetic activity payload from the provisioned seed companies so
    // the feed event company-button test-ids reference real seed UUIDs. No DB
    // mutations — seed data is read-only. Feed pagination and the mobile
    // infinite-scroll test (which relies on deterministic synthetic IDs) are
    // skipped in seed mode via the `test.skip(isReal, ...)` guards already in
    // the dashboard spec.
    await mockActivity(page, buildActivityFromProvisioned(companies));
    return;
  }

  await mockActivity(page, fixtures.activity);
  if (fixtures.feed) await mockFeed(page, fixtures.feed);
};
