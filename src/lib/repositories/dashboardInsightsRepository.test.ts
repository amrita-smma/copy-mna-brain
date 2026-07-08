import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardInsightsRepository } from './dashboardInsightsRepository';

// Chainable db mock. `.groupBy` is the terminal for grouped queries; `.where`
// is the terminal for count queries (no orderBy/groupBy after it). `.execute`
// is the terminal for raw-SQL queries (countNewDeals uses a UNION subquery).
// Each test sets the resolved value on whichever terminal the method under test awaits.
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  groupBy: vi.fn(),
  execute: vi.fn(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.leftJoin.mockReturnThis();
  mockDb.innerJoin.mockReturnThis();
  mockDb.where.mockReturnThis();
}

const WINDOW_FROM = new Date('2026-06-01T00:00:00.000Z');
const WINDOW_TO = new Date('2026-06-22T00:00:00.000Z');

describe('DashboardInsightsRepository.getStageCounts', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  it('groups by pipeline_stage and coerces counts to numbers', async () => {
    mockDb.groupBy.mockResolvedValueOnce([
      { stage: 'L0', count: '138' },
      { stage: 'L1', count: 13 },
    ]);

    const result = await repo.getStageCounts(WINDOW_FROM, WINDOW_TO);

    expect(mockDb.groupBy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { stage: 'L0', count: 138 },
      { stage: 'L1', count: 13 },
    ]);
  });
});

describe('DashboardInsightsRepository.getStageEntryCounts', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  it('runs a single UNION query and coerces the per-stage counts to numbers', async () => {
    mockDb.execute.mockResolvedValueOnce([
      { stage: 'L0', count: '45' },
      { stage: 'L1', count: 12 },
      { stage: 'L3', count: '2' },
    ]);

    const result = await repo.getStageEntryCounts(WINDOW_FROM, WINDOW_TO);

    // One raw-SQL query (created-at UNION stage-change logs), not a grouped select.
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(mockDb.groupBy).not.toHaveBeenCalled();
    expect(result).toEqual([
      { stage: 'L0', count: 45 },
      { stage: 'L1', count: 12 },
      { stage: 'L3', count: 2 },
    ]);
  });

  it('returns [] when no companies entered any stage in the window', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    await expect(repo.getStageEntryCounts(WINDOW_FROM, WINDOW_TO)).resolves.toEqual([]);
  });
});

describe('DashboardInsightsRepository breakdowns', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  it('runs a single UNION query (created + moved-in) and coerces null keys / counts', async () => {
    mockDb.execute.mockResolvedValueOnce([
      { key: 'CMP', stage: 'L0', count: '42' },
      { key: null, stage: 'L1', count: 3 },
    ]);

    const result = await repo.getSegmentBreakdown(WINDOW_FROM, WINDOW_TO);

    // Raw-SQL UNION (created-at-stage UNION stage-change logs), not a grouped
    // select — covers dropped companies and companies promoted into a stage.
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(mockDb.groupBy).not.toHaveBeenCalled();
    expect(result).toEqual([
      { key: 'CMP', stage: 'L0', count: 42 },
      { key: null, stage: 'L1', count: 3 },
    ]);
  });

  it('exposes country and banker breakdowns via the same shape', async () => {
    mockDb.execute.mockResolvedValue([{ key: 'Japan', stage: 'L0', count: 41 }]);

    await expect(repo.getCountryBreakdown(WINDOW_FROM, WINDOW_TO)).resolves.toEqual([
      { key: 'Japan', stage: 'L0', count: 41 },
    ]);
    await expect(repo.getBankerBreakdown(WINDOW_FROM, WINDOW_TO)).resolves.toEqual([
      { key: 'Japan', stage: 'L0', count: 41 },
    ]);
  });
});

describe('DashboardInsightsRepository.getBankerResponseProfiles', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  it('maps per-firm rows, coercing p50/pair_count and the gap array to numbers', async () => {
    mockDb.execute.mockResolvedValueOnce([
      { name: 'Golden Sacks', p50_seconds: '21600', pair_count: '9', gaps: ['6480', 21600, '51840'] },
      { name: 'JP Organ', p50_seconds: 108000, pair_count: 9, gaps: [108000] },
    ]);

    const result = await repo.getBankerResponseProfiles();

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { name: 'Golden Sacks', p50Seconds: 21600, pairCount: 9, gaps: [6480, 21600, 51840] },
      { name: 'JP Organ', p50Seconds: 108000, pairCount: 9, gaps: [108000] },
    ]);
  });

  it('parses a Postgres array-literal string for gaps (driver returns "{...}")', async () => {
    // Some drivers return array_agg as the raw Postgres array literal rather
    // than a JS array; it must be parsed instead of crashing on `.map`.
    mockDb.execute.mockResolvedValueOnce([
      { name: 'Golden Sacks', p50_seconds: '21600', pair_count: '3', gaps: '{6480,21600,51840}' },
    ]);

    await expect(repo.getBankerResponseProfiles()).resolves.toEqual([
      { name: 'Golden Sacks', p50Seconds: 21600, pairCount: 3, gaps: [6480, 21600, 51840] },
    ]);
  });

  it('parses an empty Postgres array literal ("{}") to []', async () => {
    mockDb.execute.mockResolvedValueOnce([
      { name: 'JP Organ', p50_seconds: '100', pair_count: '0', gaps: '{}' },
    ]);

    await expect(repo.getBankerResponseProfiles()).resolves.toEqual([
      { name: 'JP Organ', p50Seconds: 100, pairCount: 0, gaps: [] },
    ]);
  });

  it('tolerates a null gaps array', async () => {
    mockDb.execute.mockResolvedValueOnce([
      { name: 'Organ Stanley', p50_seconds: '50400', pair_count: '1', gaps: null },
    ]);
    await expect(repo.getBankerResponseProfiles()).resolves.toEqual([
      { name: 'Organ Stanley', p50Seconds: 50400, pairCount: 1, gaps: [] },
    ]);
  });

  it('returns [] (not throw) when the analytics tables are unavailable', async () => {
    mockDb.execute.mockRejectedValueOnce(
      new Error('relation "analytics.email_workspace" does not exist'),
    );
    await expect(repo.getBankerResponseProfiles()).resolves.toEqual([]);
  });
});

describe('DashboardInsightsRepository.getStaleCandidates', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  it('joins sponsor/captain users, selects the staleness timestamps, and stringifies the stage', async () => {
    mockDb.where.mockResolvedValueOnce([
      {
        id: 'c1',
        target: 'Acme',
        project_name: null,
        pipeline_stage: 'L2',
        last_activity_at: null,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-02T00:00:00.000Z',
        deal_sponsor_name: 'Jane Doe',
        deal_captain_name: null,
      },
    ]);

    const result = await repo.getStaleCandidates(WINDOW_FROM, WINDOW_TO);

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).toHaveProperty('last_activity_at');
    expect(selectArg).toHaveProperty('pipeline_stage');
    expect(selectArg).toHaveProperty('deal_sponsor_name');
    expect(selectArg).toHaveProperty('deal_captain_name');
    // Two joins: one for the sponsor user, one for the captain user.
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(2);
    expect(result[0]).toMatchObject({
      id: 'c1',
      pipeline_stage: 'L2',
      deal_sponsor_name: 'Jane Doe',
      deal_captain_name: null,
    });
  });
});

describe('DashboardInsightsRepository count helpers', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  const FROM = new Date('2026-06-01T00:00:00.000Z');
  const TO = new Date('2026-06-22T00:00:00.000Z');

  it('countNewDeals returns the numeric count from the row', async () => {
    mockDb.execute.mockResolvedValueOnce([{ count: '45' }]);
    await expect(repo.countNewDeals(FROM, TO)).resolves.toBe(45);
  });

  it('countScreenedL0 returns 0 when no rows come back', async () => {
    mockDb.where.mockResolvedValueOnce([]);
    await expect(repo.countScreenedL0(FROM, TO)).resolves.toBe(0);
  });

  it('countDecksGenerated counts company slides in the window', async () => {
    mockDb.where.mockResolvedValueOnce([{ value: 34 }]);
    await expect(repo.countDecksGenerated(FROM, TO)).resolves.toBe(34);
  });

  it('countWorkforceRuns counts parent runs in the window', async () => {
    mockDb.where.mockResolvedValueOnce([{ value: 6 }]);
    await expect(repo.countWorkforceRuns(FROM, TO)).resolves.toBe(6);
  });

  it('getCompanyCardStats returns total with completed/failed split', async () => {
    mockDb.where.mockResolvedValueOnce([{ total: '20', completed: '18', failed: 2 }]);
    await expect(repo.getCompanyCardStats(FROM, TO)).resolves.toEqual({
      total: 20,
      completed: 18,
      failed: 2,
    });
  });

  it('getCompanyCardStats defaults to zeros when no row comes back', async () => {
    mockDb.where.mockResolvedValueOnce([]);
    await expect(repo.getCompanyCardStats(FROM, TO)).resolves.toEqual({
      total: 0,
      completed: 0,
      failed: 0,
    });
  });

  it('getAiOpinionStats returns the verdict breakdown', async () => {
    mockDb.where.mockResolvedValueOnce([{ total: '12', pass: 7, fail: '3', tentative: 2 }]);
    await expect(repo.getAiOpinionStats(FROM, TO)).resolves.toEqual({
      total: 12,
      pass: 7,
      fail: 3,
      tentative: 2,
    });
  });

  it('getScreeningStats returns the result breakdown and distinct companies', async () => {
    mockDb.where.mockResolvedValueOnce([
      { companiesScreened: '9', total: 40, pass: '22', fail: 12, inconclusive: '5', error: 1 },
    ]);
    await expect(repo.getScreeningStats(FROM, TO)).resolves.toEqual({
      companiesScreened: 9,
      total: 40,
      pass: 22,
      fail: 12,
      inconclusive: 5,
      error: 1,
    });
  });
});

describe('DashboardInsightsRepository.getHitlStats', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never, 'workspace-1');
  });

  it('sums resolved decisions in-window and counts pending runs as a snapshot', async () => {
    // First query (resolved sum) then second query (pending count).
    mockDb.where
      .mockResolvedValueOnce([{ value: '23' }])
      .mockResolvedValueOnce([{ value: 2 }]);

    const result = await repo.getHitlStats(
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-22T00:00:00.000Z'),
    );

    expect(result).toEqual({ resolved: 23, pending: 2 });
  });
});
