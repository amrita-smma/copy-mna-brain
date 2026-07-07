import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanySlidesRepository } from './companySlidesRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
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
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CompanySlidesRepository', () => {
  let mockDb: MockDb;
  let repo: CompanySlidesRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new CompanySlidesRepository(mockDb as never, 'workspace-a');
  });

  it('findByCompanyId scopes the lookup via the companies subquery', async () => {
    const rows = [{ id: 's1', company_id: 'company-1', sort_order: 0 }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByCompanyId('company-1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('insert writes the row without stamping a workspace_id', async () => {
    const row = { id: 's1', company_id: 'company-1', title: 'Untitled' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ company_id: 'company-1', title: 'Untitled' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ company_id: 'company-1', title: 'Untitled' });
  });

  it('update scopes the write via the companies subquery', async () => {
    const row = { id: 's1', company_id: 'company-1', title: 'Renamed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.update('s1', { title: 'Renamed' } as never);

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('update throws when no row matches', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    await expect(repo.update('missing', {} as never)).rejects.toThrow(/not found/);
  });

  it('delete scopes the write via the companies subquery', async () => {
    await repo.delete('s1');
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot find another workspace\'s slides', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new CompanySlidesRepository(dbA as never, 'workspace-a');
      const repoB = new CompanySlidesRepository(dbB as never, 'workspace-b');

      dbA.orderBy.mockResolvedValueOnce([{ id: 's1', company_id: 'company-1' }]);
      dbB.orderBy.mockResolvedValueOnce([]);

      expect(await repoA.findByCompanyId('company-1')).toHaveLength(1);
      expect(await repoB.findByCompanyId('company-1')).toHaveLength(0);
    });
  });
});
