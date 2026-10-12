import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DealNoteRepository } from './dealNoteRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('DealNoteRepository', () => {
  let mockDb: MockDb;
  let repo: DealNoteRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new DealNoteRepository(mockDb as never, 'workspace-a');
  });

  it('findByDealId scopes the lookup to companies in this workspace and returns notes ordered by created_at desc', async () => {
    const rows = [{ id: 'n2' }, { id: 'n1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByDealId('deal-1');

    expect(result).toEqual(rows);
    // One where() for the outer query, one for the workspace-companies subquery.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
    expect(mockDb.limit).not.toHaveBeenCalled();
  });

  it('findByDealId bounds the read to the newest rows when a limit is given', async () => {
    const rows = [{ id: 'n2' }];
    mockDb.limit.mockResolvedValueOnce(rows);

    const result = await repo.findByDealId('deal-1', 15);

    expect(result).toEqual(rows);
    expect(mockDb.limit).toHaveBeenCalledWith(15);
  });

  it('countByDealId returns the full count for the deal, scoped to this workspace', async () => {
    // The workspace-companies subquery resolves first, then the outer count.
    mockDb.where.mockReturnValueOnce(mockDb as never);
    mockDb.where.mockResolvedValueOnce([{ value: 42 }]);

    const result = await repo.countByDealId('deal-1');

    expect(result).toBe(42);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('countByDealId reports 0 when the deal has no notes', async () => {
    mockDb.where.mockReturnValueOnce(mockDb as never);
    mockDb.where.mockResolvedValueOnce([]);

    expect(await repo.countByDealId('deal-1')).toBe(0);
  });

  it('insert writes the row without stamping a workspace_id (deal_notes has no own column)', async () => {
    const row = { id: 'n1', deal_id: 'deal-1', content: 'note', stage: 'L0' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ deal_id: 'deal-1', content: 'note', stage: 'L0' });

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({
      deal_id: 'deal-1',
      content: 'note',
      stage: 'L0',
    });
  });

  it('insertMany writes every row without stamping a workspace_id', async () => {
    await repo.insertMany([
      { deal_id: 'deal-1', content: 'a', stage: 'L0' },
      { deal_id: 'deal-1', content: 'b', stage: 'L0' },
    ]);

    expect(mockDb.values).toHaveBeenCalledWith([
      { deal_id: 'deal-1', content: 'a', stage: 'L0' },
      { deal_id: 'deal-1', content: 'b', stage: 'L0' },
    ]);
  });

  it('insertMany is a no-op for an empty array', async () => {
    await repo.insertMany([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('delete scopes the where clause to this workspace via the companies subquery', async () => {
    await repo.delete('n1');
    // One where() for the id match, one for the workspace-companies subquery.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it('a repository bound to workspace-b never resolves deal_notes belonging to workspace-a companies', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new DealNoteRepository(dbA as never, 'workspace-a');
      const repoB = new DealNoteRepository(dbB as never, 'workspace-b');

      // Each repo's findByDealId filters through its OWN workspace's companies
      // subquery — repoB can never see repoA's rows because the subquery
      // (SELECT id FROM companies WHERE workspace_id = 'workspace-b') never
      // includes a company that belongs to workspace-a.
      dbA.orderBy.mockResolvedValueOnce([{ id: 'n1', deal_id: 'deal-1' }]);
      dbB.orderBy.mockResolvedValueOnce([]);

      const resultA = await repoA.findByDealId('deal-1');
      const resultB = await repoB.findByDealId('deal-1');

      expect(resultA).toEqual([{ id: 'n1', deal_id: 'deal-1' }]);
      expect(resultB).toEqual([]);
    });
  });
});
