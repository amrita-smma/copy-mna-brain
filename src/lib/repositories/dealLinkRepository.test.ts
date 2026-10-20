import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DealLinkRepository } from './dealLinkRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
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
    orderBy: vi.fn(),
    limit: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('DealLinkRepository', () => {
  let mockDb: MockDb;
  let repo: DealLinkRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new DealLinkRepository(mockDb as never, 'workspace-a');
  });

  it('findByDealId scopes the lookup to companies in this workspace', async () => {
    const rows = [{ id: 'link1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByDealId('deal-1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('insert writes the row without stamping a workspace_id', async () => {
    const row = { id: 'link1', deal_id: 'deal-1', url: 'https://example.com', stage: 'L0' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ deal_id: 'deal-1', url: 'https://example.com', stage: 'L0' });

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ deal_id: 'deal-1', url: 'https://example.com', stage: 'L0' });
  });

  it('delete scopes the where clause via the companies subquery', async () => {
    await repo.delete('link1');
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace never resolves another workspace\'s deal_links', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new DealLinkRepository(dbA as never, 'workspace-a');
      const repoB = new DealLinkRepository(dbB as never, 'workspace-b');

      dbA.orderBy.mockResolvedValueOnce([{ id: 'link1' }]);
      dbB.orderBy.mockResolvedValueOnce([]);

      expect(await repoA.findByDealId('deal-1')).toHaveLength(1);
      expect(await repoB.findByDealId('deal-1')).toHaveLength(0);
    });
  });

  it('findById returns the row scoped to this workspace', async () => {
    const row = { id: 'link1', deal_id: 'deal-1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    await expect(repo.findById('link1')).resolves.toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findById throws when the link is missing or in another workspace', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findById('link1')).rejects.toThrow(/not found/);
  });

  it('markFeatured sets is_featured on the one link, scoped to this workspace', async () => {
    await repo.markFeatured('link1');
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({ is_featured: true });
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('clearFeaturedByDealId unsets is_featured scoped to the deal and this workspace', async () => {
    await repo.clearFeaturedByDealId('deal-1');
    expect(mockDb.set).toHaveBeenCalledWith({ is_featured: false });
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });
});
