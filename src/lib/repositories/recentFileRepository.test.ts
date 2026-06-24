import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecentFileRepository } from './recentFileRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
}

describe('RecentFileRepository', () => {
  let mockDb: MockDb;
  let repo: RecentFileRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn(),
    };
    repo = new RecentFileRepository(mockDb as never);
  });

  it('recordOpen upserts on the (user_id, file_key) conflict target', async () => {
    mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

    await repo.recordOpen('u1', 'deck.pptx', 'deals/abc/deck.pptx');

    expect(mockDb.values).toHaveBeenCalledWith({
      user_id: 'u1',
      file_name: 'deck.pptx',
      file_key: 'deals/abc/deck.pptx',
    });
    expect(mockDb.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    const arg = mockDb.onConflictDoUpdate.mock.calls[0][0];
    expect(arg.set).toMatchObject({ file_name: 'deck.pptx' });
  });

  it('listByUser returns rows ordered by opened_at with limit/offset applied', async () => {
    const rows = [
      { id: 'r1', user_id: 'u1', file_name: 'a.pdf', file_key: 'k1', opened_at: '2026-06-23' },
      { id: 'r2', user_id: 'u1', file_name: 'b.pdf', file_key: 'k2', opened_at: '2026-06-22' },
    ];
    mockDb.offset.mockResolvedValueOnce(rows);

    const result = await repo.listByUser('u1', { limit: 10, offset: 20 });

    expect(result).toEqual(rows);
    expect(mockDb.limit).toHaveBeenCalledWith(10);
    expect(mockDb.offset).toHaveBeenCalledWith(20);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('countByUser returns the integer count', async () => {
    mockDb.where.mockResolvedValueOnce([{ count: 7 }]);

    const result = await repo.countByUser('u1');

    expect(result).toBe(7);
  });

  it('countByUser returns 0 when the query yields no rows', async () => {
    mockDb.where.mockResolvedValueOnce([]);

    const result = await repo.countByUser('u1');

    expect(result).toBe(0);
  });
});
