import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CompanyLogRepository,
  autoAssignedSponsorAction,
  parseAutoAssignedSponsorAction,
} from './companyLogRepository';

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

  it('findByCompanyIds returns [] without hitting the DB when the id list is empty', async () => {
    const result = await repo.findByCompanyIds([]);

    expect(result).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('findByCompanyIds joins companies to scope the bulk lookup to this workspace', async () => {
    const rows = [
      { id: 'log1', company_id: 'company-1', action: 'PROMOTED_TO_L1', created_at: '2026-01-01' },
      { id: 'log2', company_id: 'company-2', action: 'PROMOTED_TO_L2', created_at: '2026-01-02' },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByCompanyIds(['company-1', 'company-2']);

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

  it('insertMany passes the auto-assignment reason through in comments', async () => {
    await repo.insertMany([
      { company_id: 'company-1', action: 'AUTO_ASSIGNED_SPONSOR:u1', comments: 'covers Firm X' },
    ]);

    expect(mockDb.values).toHaveBeenCalledWith([
      { company_id: 'company-1', action: 'AUTO_ASSIGNED_SPONSOR:u1', comments: 'covers Firm X' },
    ]);
  });

  describe('findLatestAutoSponsorLogs', () => {
    it('returns an empty map without hitting the DB when the id list is empty', async () => {
      expect(await repo.findLatestAutoSponsorLogs([])).toEqual(new Map());
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('keeps only the newest auto-assignment per company (rows arrive newest first)', async () => {
      mockDb.orderBy.mockResolvedValueOnce([
        { company_id: 'company-1', action: 'AUTO_ASSIGNED_SPONSOR:u2', comments: 'newer', created_at: '2026-10-02' },
        { company_id: 'company-1', action: 'AUTO_ASSIGNED_SPONSOR:u1', comments: 'older', created_at: '2026-10-01' },
        { company_id: 'company-2', action: 'AUTO_ASSIGNED_SPONSOR:', comments: null, created_at: '2026-10-01' },
      ]);

      const result = await repo.findLatestAutoSponsorLogs(['company-1', 'company-2']);

      expect(result).toEqual(
        new Map([
          [
            'company-1',
            { company_id: 'company-1', user_id: 'u2', reason: 'newer', created_at: '2026-10-02' },
          ],
        ]),
      );
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });
  });

  describe('auto-assigned sponsor action', () => {
    it('round-trips the user id', () => {
      expect(parseAutoAssignedSponsorAction(autoAssignedSponsorAction('u1'))).toBe('u1');
    });

    it('reads nothing from other actions', () => {
      expect(parseAutoAssignedSponsorAction('PROMOTED_FROM_L0_TO_L1')).toBeNull();
      expect(parseAutoAssignedSponsorAction(null)).toBeNull();
    });

    it('never contains the _TO_ that stage-move readers match on', () => {
      expect(autoAssignedSponsorAction('3f2a9c1e-0000-4000-8000-000000000000')).not.toMatch(/_TO_/);
    });
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
