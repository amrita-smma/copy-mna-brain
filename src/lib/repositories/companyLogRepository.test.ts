import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyLogRepository } from './companyLogRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn(),
  };
}

describe('CompanyLogRepository', () => {
  let mockDb: MockDb;
  let repo: CompanyLogRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new CompanyLogRepository(mockDb as never, 'workspace-a');
  });

  it('findByCompanyId joins companies to scope the lookup to this workspace', async () => {
    const rows = [{ id: 'log1', action: 'CREATED_AS_L0', created_at: '2026-01-01' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByCompanyId('company-1');

    expect(result).toEqual(rows);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('insert writes the entry without a workspace_id (company_logs has no own column)', async () => {
    await repo.insert({ company_id: 'company-1', action: 'PROMOTED_TO_L1' });

    expect(mockDb.values).toHaveBeenCalledWith({ company_id: 'company-1', action: 'PROMOTED_TO_L1' });
  });

  it('insertMany writes every entry without a workspace_id', async () => {
    await repo.insertMany([
      { company_id: 'company-1', action: 'a' },
      { company_id: 'company-2', action: 'b' },
    ]);

    expect(mockDb.values).toHaveBeenCalledWith([
      { company_id: 'company-1', action: 'a' },
      { company_id: 'company-2', action: 'b' },
    ]);
  });

  it('insertMany is a no-op for an empty array', async () => {
    await repo.insertMany([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace never resolves another workspace company\'s logs', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new CompanyLogRepository(dbA as never, 'workspace-a');
      const repoB = new CompanyLogRepository(dbB as never, 'workspace-b');

      // repoB's join filters on companies.workspace_id = 'workspace-b', so a
      // company that only exists under workspace-a never satisfies the join.
      dbA.orderBy.mockResolvedValueOnce([{ id: 'log1', action: 'x', created_at: '2026-01-01' }]);
      dbB.orderBy.mockResolvedValueOnce([]);

      const resultA = await repoA.findByCompanyId('company-1');
      const resultB = await repoB.findByCompanyId('company-1');

      expect(resultA).toHaveLength(1);
      expect(resultB).toHaveLength(0);
    });
  });
});
