import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DealDocumentRepository } from './dealDocumentRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('DealDocumentRepository', () => {
  let mockDb: MockDb;
  let repo: DealDocumentRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new DealDocumentRepository(mockDb as never, 'workspace-a');
  });

  it('findById scopes the lookup via the companies subquery and returns the row', async () => {
    const row = { id: 'doc1', deal_id: 'deal-1', file_name: 'a.pdf', file_path: 'p/a.pdf', stage: 'L0' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findById('doc1');

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findById throws when no row matches (wrong id or wrong workspace)', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findById('missing')).rejects.toThrow(/not found/);
  });

  it('findByDealId returns every document for the deal, newest first', async () => {
    const rows = [
      { id: 'doc-2', deal_id: 'deal-1', created_at: '2026-04-01T00:00:00.000Z' },
      { id: 'doc-1', deal_id: 'deal-1', created_at: '2026-01-01T00:00:00.000Z' },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByDealId('deal-1');

    expect(result).toEqual(rows);
    // Two where() calls: the workspace-companies subquery and the outer query.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('findByDealId returns an empty list when the deal has no documents', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);
    await expect(repo.findByDealId('deal-1')).resolves.toEqual([]);
  });

  it('findByDealId caps the read when a limit is given', async () => {
    mockDb.orderBy.mockReturnValueOnce({ limit: mockDb.limit });
    mockDb.limit.mockResolvedValueOnce([]);

    await repo.findByDealId('deal-1', 50);

    expect(mockDb.limit).toHaveBeenCalledWith(50);
  });

  it('findByDealId issues no LIMIT when none is requested', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.findByDealId('deal-1');

    expect(mockDb.limit).not.toHaveBeenCalled();
  });

  it('findFeaturedByDealId returns the featured row scoped to the deal and workspace', async () => {
    const row = { id: 'doc1', deal_id: 'deal-1', is_featured: true };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findFeaturedByDealId('deal-1');

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findFeaturedByDealId returns null when the deal has no featured document', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findFeaturedByDealId('deal-1')).resolves.toBeNull();
  });

  it('clearFeaturedByDealId scopes the update to the deal, is_featured rows, and this workspace', async () => {
    await repo.clearFeaturedByDealId('deal-1');

    expect(mockDb.set).toHaveBeenCalledWith({ is_featured: false });
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findFilePathsByDealId scopes to companies in this workspace and drops falsy paths', async () => {
    // First where() call is the workspace-companies subquery; the second is
    // the outer, awaited query that actually resolves the rows.
    mockDb.where
      .mockReturnValueOnce(mockDb)
      .mockResolvedValueOnce([{ file_path: 'p/a.pdf' }, { file_path: null }]);

    const result = await repo.findFilePathsByDealId('deal-1');

    expect(result).toEqual(['p/a.pdf']);
  });

  it('insert writes the row without stamping a workspace_id and returns it', async () => {
    const row = { id: 'doc1', deal_id: 'deal-1', file_name: 'a.pdf', file_path: 'p/a.pdf', stage: 'L0' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({
      deal_id: 'deal-1',
      file_name: 'a.pdf',
      file_path: 'p/a.pdf',
      stage: 'L0',
    });

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({
      deal_id: 'deal-1',
      file_name: 'a.pdf',
      file_path: 'p/a.pdf',
      stage: 'L0',
    });
  });

  it('insert throws when returning is empty', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    await expect(
      repo.insert({
        deal_id: 'deal-1',
        file_name: 'a.pdf',
        file_path: 'p/a.pdf',
        stage: 'L0',
      }),
    ).rejects.toThrow(/Failed to insert/);
  });

  it('updatePartial scopes the update via the companies subquery', async () => {
    await repo.updatePartial('doc1', { processing_status: 'completed', tags: ['acme'] });

    expect(mockDb.set).toHaveBeenCalledWith({ processing_status: 'completed', tags: ['acme'] });
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot find another workspace\'s document', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new DealDocumentRepository(dbA as never, 'workspace-a');
      const repoB = new DealDocumentRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 'doc1', deal_id: 'deal-1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      await expect(repoA.findById('doc1')).resolves.toMatchObject({ id: 'doc1' });
      await expect(repoB.findById('doc1')).rejects.toThrow(/not found/);
    });
  });
});
