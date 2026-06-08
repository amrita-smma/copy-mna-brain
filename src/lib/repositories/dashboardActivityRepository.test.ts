import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardActivityRepository } from './dashboardActivityRepository';

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
};

describe('DashboardActivityRepository.getDroppedDeals', () => {
  let repo: DashboardActivityRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    repo = new DashboardActivityRepository(mockDb as never);
  });

  it('does not select the general-purpose remarks column', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.getDroppedDeals(new Date('2026-01-01'), new Date('2026-01-08'));

    const selectArg = mockDb.select.mock.calls[0][0];
    expect(selectArg).not.toHaveProperty('remarks');
    // The fields the dropped-deals feed actually relies on remain selected.
    expect(selectArg).toHaveProperty('target');
    expect(selectArg).toHaveProperty('dropped_at');
    expect(selectArg).toHaveProperty('dropped_reason');
    expect(selectArg).toHaveProperty('thesis_content');
  });

  it('returns the rows produced by the query', async () => {
    const rows = [{ id: 'c1', target: 'Acme', dropped_at: '2026-01-05T00:00:00.000Z' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.getDroppedDeals(new Date('2026-01-01'), new Date('2026-01-08'));

    expect(result).toEqual(rows);
  });
});
