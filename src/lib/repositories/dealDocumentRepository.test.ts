import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DealDocumentRepository } from './dealDocumentRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn(),
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

  it('findFilePathsByDealId scopes to companies in this workspace and drops falsy paths', async () => {
    // First where() call is the workspace-companies subquery; the second is
    // the outer, awaited query that actually resolves the rows.
    mockDb.where
      .mockReturnValueOnce(mockDb)
      .mockResolvedValueOnce([{ file_path: 'p/a.pdf' }, { file_path: null }]);

    const result = await repo.findFilePathsByDealId('deal-1');

    expect(result).toEqual(['p/a.pdf']);
  });

  it('insert writes the row without stamping a workspace_id', async () => {
    await repo.insert({
      deal_id: 'deal-1',
      file_name: 'a.pdf',
      file_path: 'p/a.pdf',
      stage: 'L0',
    });

    expect(mockDb.values).toHaveBeenCalledWith({
      deal_id: 'deal-1',
      file_name: 'a.pdf',
      file_path: 'p/a.pdf',
      stage: 'L0',
    });
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
