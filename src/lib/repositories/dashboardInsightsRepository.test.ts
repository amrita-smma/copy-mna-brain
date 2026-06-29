import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardInsightsRepository } from './dashboardInsightsRepository';

// Chainable db mock. `.groupBy` is the terminal for grouped queries; `.where`
// is the terminal for count queries (no orderBy/groupBy after it). `.execute`
// is the terminal for raw-SQL queries (countNewDeals uses a UNION subquery).
// Each test sets the resolved value on whichever terminal the method under test awaits.
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  groupBy: vi.fn(),
  execute: vi.fn(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.where.mockReturnThis();
}

describe('DashboardInsightsRepository.getStageCounts', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never);
  });

  it('groups by pipeline_stage and coerces counts to numbers', async () => {
    mockDb.groupBy.mockResolvedValueOnce([
      { stage: 'L0', count: '138' },
      { stage: 'L1', count: 13 },
    ]);

    const result = await repo.getStageCounts();

    expect(mockDb.groupBy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { stage: 'L0', count: 138 },
      { stage: 'L1', count: 13 },
    ]);
  });
});

describe('DashboardInsightsRepository breakdowns', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never);
  });

  it('normalises null keys and groups by the dimension plus stage', async () => {
    mockDb.groupBy.mockResolvedValueOnce([
      { key: 'CMP', stage: 'L0', count: 42 },
      { key: null, stage: 'L1', count: 3 },
    ]);

    const result = await repo.getSegmentBreakdown();

    // Grouped by two columns (dimension, pipeline_stage).
    expect(mockDb.groupBy).toHaveBeenCalledTimes(1);
    expect(mockDb.groupBy.mock.calls[0]).toHaveLength(2);
    expect(result).toEqual([
      { key: 'CMP', stage: 'L0', count: 42 },
      { key: null, stage: 'L1', count: 3 },
    ]);
  });

  it('exposes country and banker breakdowns via the same shape', async () => {
    mockDb.groupBy.mockResolvedValue([{ key: 'Japan', stage: 'L0', count: 41 }]);

    await expect(repo.getCountryBreakdown()).resolves.toEqual([
      { key: 'Japan', stage: 'L0', count: 41 },
    ]);
    await expect(repo.getBankerBreakdown()).resolves.toEqual([
      { key: 'Japan', stage: 'L0', count: 41 },
    ]);
  });
});

describe('DashboardInsightsRepository.getActiveNonL0Deals', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never);
  });

  it('selects the staleness timestamps and stringifies the stage', async () => {
    mockDb.where.mockResolvedValueOnce([
      {
        id: 'c1',
        target: 'Acme',
        project_name: null,
        pipeline_stage: 'L2',
        last_activity_at: null,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-02T00:00:00.000Z',
      },
    ]);

    const result = await repo.getActiveNonL0Deals();

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).toHaveProperty('last_activity_at');
    expect(selectArg).toHaveProperty('pipeline_stage');
    expect(result[0]).toMatchObject({ id: 'c1', pipeline_stage: 'L2' });
  });
});

describe('DashboardInsightsRepository count helpers', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never);
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
});

describe('DashboardInsightsRepository.getHitlStats', () => {
  let repo: DashboardInsightsRepository;

  beforeEach(() => {
    resetDb();
    repo = new DashboardInsightsRepository(mockDb as never);
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
