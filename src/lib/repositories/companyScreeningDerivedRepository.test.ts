import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyScreeningDerivedRepository } from './companyScreeningDerivedRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
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
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CompanyScreeningDerivedRepository', () => {
  let mockDb: MockDb;
  let repo: CompanyScreeningDerivedRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new CompanyScreeningDerivedRepository(mockDb as never, 'workspace-a');
  });

  it('findByCompany scopes the lookup via the companies subquery', async () => {
    const row = { company_id: 'company-1', l1_screening_result: 'pass' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findByCompany('company-1');

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findByCompany returns null when no row matches', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findByCompany('company-1')).resolves.toBeNull();
  });

  it('findByCompanies returns [] without querying when given an empty array', async () => {
    const result = await repo.findByCompanies([]);
    expect(result).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('upsertByCompany writes without stamping a workspace_id, keyed by company_id', async () => {
    await repo.upsertByCompany({ company_id: 'company-1', l1_screening_result: 'pass' } as never);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'company-1', l1_screening_result: 'pass' }),
    );
    expect(mockDb.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('deleteByCompany scopes the delete via the companies subquery', async () => {
    await repo.deleteByCompany('company-1');
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot find another workspace\'s derived row', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new CompanyScreeningDerivedRepository(dbA as never, 'workspace-a');
      const repoB = new CompanyScreeningDerivedRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ company_id: 'company-1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findByCompany('company-1')).not.toBeNull();
      expect(await repoB.findByCompany('company-1')).toBeNull();
    });
  });
});
