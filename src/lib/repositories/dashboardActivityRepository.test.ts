import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardActivityRepository } from './dashboardActivityRepository';

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
};

describe('DashboardActivityRepository.getDroppedDeals', () => {
  let repo: DashboardActivityRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.innerJoin.mockReturnThis();
    mockDb.leftJoin.mockReturnThis();
    mockDb.where.mockReturnThis();
    repo = new DashboardActivityRepository(mockDb as never, 'workspace-1');
  });

  it('selects the core dropped-deal fields', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.getDroppedDeals(new Date('2026-01-01'), new Date('2026-01-08'));

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).toHaveProperty('target');
    expect(selectArg).toHaveProperty('dropped_at');
    expect(selectArg).toHaveProperty('dropped_reason');
    expect(selectArg).toHaveProperty('remarks');
    expect(selectArg).toHaveProperty('thesis_content');
    expect(selectArg).toHaveProperty('logo_url');
  });

  it('selects FY financials and entered_by_name for the per-row summary', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.getDroppedDeals(new Date('2026-01-01'), new Date('2026-01-08'));

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).toHaveProperty('revenue_usd_mn');
    expect(selectArg).toHaveProperty('ebitda_usd_mn');
    expect(selectArg).toHaveProperty('ev_usd_mn');
    expect(selectArg).toHaveProperty('entered_by_name');
    expect(selectArg).toHaveProperty('deal_sponsor_name');
    // Left joins: financials, users (entered_by), aliased users (deal_sponsor).
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(3);
  });

  it('returns the rows produced by the query', async () => {
    const rows = [{ id: 'c1', target: 'Acme', dropped_at: '2026-01-05T00:00:00.000Z' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.getDroppedDeals(new Date('2026-01-01'), new Date('2026-01-08'));

    expect(result).toEqual(rows);
  });

  it('accepts a companyId scope without a limit (full-timeline path)', async () => {
    const rows = [{ id: 'co-1', target: 'Acme', dropped_at: '2026-01-05T00:00:00.000Z' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.getDroppedDeals(
      new Date(0),
      new Date('9999-12-31T23:59:59.999Z'),
      undefined,
      'co-1',
    );

    // No limit applied: the terminal orderBy result is returned directly (the
    // company scope is folded into the where clause, not a separate call).
    expect(result).toEqual(rows);
  });
});

describe('DashboardActivityRepository.getPipelineMoves', () => {
  let repo: DashboardActivityRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.innerJoin.mockReturnThis();
    mockDb.leftJoin.mockReturnThis();
    mockDb.where.mockReturnThis();
    repo = new DashboardActivityRepository(mockDb as never, 'workspace-1');
  });

  it('left-joins financials and users, selecting them alongside the move metadata', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.getPipelineMoves(new Date('2026-01-01'), new Date('2026-01-08'));

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).toHaveProperty('action');
    expect(selectArg).toHaveProperty('logo_url');
    expect(selectArg).toHaveProperty('revenue_usd_mn');
    expect(selectArg).toHaveProperty('ebitda_usd_mn');
    expect(selectArg).toHaveProperty('ev_usd_mn');
    expect(selectArg).toHaveProperty('entered_by_name');
    expect(selectArg).toHaveProperty('deal_sponsor_name');
    // Left joins: financials, users (entered_by), aliased users (deal_sponsor).
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(3);
  });
});

describe('DashboardActivityRepository.getDiscoveredCompanies', () => {
  let repo: DashboardActivityRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.innerJoin.mockReturnThis();
    mockDb.leftJoin.mockReturnThis();
    mockDb.where.mockReturnThis();
    repo = new DashboardActivityRepository(mockDb as never, 'workspace-1');
  });

  it('selects company + FY financials and uses created_at as event_at', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.getDiscoveredCompanies(new Date('2026-01-01'), new Date('2026-01-08'));

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).toHaveProperty('target');
    expect(selectArg).toHaveProperty('event_at');
    expect(selectArg).toHaveProperty('logo_url');
    expect(selectArg).toHaveProperty('revenue_usd_mn');
    expect(selectArg).toHaveProperty('ebitda_usd_mn');
    expect(selectArg).toHaveProperty('ev_usd_mn');
    // Financials come from a left join so companies without figures still appear.
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(1);
  });

  it('caps the result with limit when provided', async () => {
    const limited = vi.fn().mockResolvedValueOnce([]);
    mockDb.orderBy.mockReturnValueOnce({ limit: limited });

    await repo.getDiscoveredCompanies(new Date('2026-01-01'), new Date('2026-01-08'), 5);

    expect(limited).toHaveBeenCalledWith(5);
  });

  it('returns the rows produced by the query', async () => {
    const rows = [{ id: 'd1', target: 'Beta', event_at: '2026-01-05T00:00:00.000Z' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.getDiscoveredCompanies(
      new Date('2026-01-01'),
      new Date('2026-01-08'),
    );

    expect(result).toEqual(rows);
  });
});
