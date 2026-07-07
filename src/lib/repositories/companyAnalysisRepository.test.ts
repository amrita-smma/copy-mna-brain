import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyAnalysisRepository } from './companyAnalysisRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CompanyAnalysisRepository', () => {
  let mockDb: MockDb;
  let repo: CompanyAnalysisRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new CompanyAnalysisRepository(mockDb as never, 'workspace-a');
  });

  it('findByCompanyId scopes the lookup via the companies subquery', async () => {
    const row = { id: 'a1', company_id: 'company-1', status: 'completed' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findByCompanyId('company-1');

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findByCompanyId returns null when no row matches', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findByCompanyId('company-1')).resolves.toBeNull();
  });

  it('insert writes the row without stamping a workspace_id', async () => {
    const row = { id: 'a1', company_id: 'company-1', status: 'pending' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ company_id: 'company-1', status: 'pending' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ company_id: 'company-1', status: 'pending' });
  });

  it('updateByCompanyId scopes the update via the companies subquery', async () => {
    const row = { id: 'a1', company_id: 'company-1', status: 'completed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.updateByCompanyId('company-1', { status: 'completed' } as never);

    expect(result).toEqual(row);
    // One where() for the workspace-companies subquery, one for the update itself.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('updateByCompanyId throws when no row matches', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    await expect(repo.updateByCompanyId('missing', {} as never)).rejects.toThrow(/not found/);
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot find another workspace\'s analysis', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new CompanyAnalysisRepository(dbA as never, 'workspace-a');
      const repoB = new CompanyAnalysisRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 'a1', company_id: 'company-1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findByCompanyId('company-1')).not.toBeNull();
      expect(await repoB.findByCompanyId('company-1')).toBeNull();
    });
  });
});
