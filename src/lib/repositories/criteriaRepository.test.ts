import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CriteriaRepository } from './criteriaRepository';

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

describe('CriteriaRepository', () => {
  let mockDb: MockDb;
  let repo: CriteriaRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new CriteriaRepository(mockDb as never, 'workspace-a');
  });

  it('findAll scopes to Tracks in this workspace when no thesisId is given', async () => {
    const rows = [{ id: 'crit-1', investment_thesis_id: 'thesis-1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findAll();

    expect(result).toEqual(rows);
    // One where() for the investment_thesis subquery, one for the outer query.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findAll additionally filters by thesisId when given', async () => {
    const rows = [{ id: 'crit-1', investment_thesis_id: 'thesis-1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findAll('thesis-1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('insert writes the row without stamping a workspace_id', async () => {
    const row = { id: 'crit-1', investment_thesis_id: 'thesis-1', name: 'Asia Revenue' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({
      name: 'Asia Revenue',
      prompt: 'Revenue from Asia > 30%',
      investment_thesis_id: 'thesis-1',
    });

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({
      name: 'Asia Revenue',
      prompt: 'Revenue from Asia > 30%',
      investment_thesis_id: 'thesis-1',
    });
  });

  it('update scopes the write via the investment_thesis subquery', async () => {
    const row = { id: 'crit-1', investment_thesis_id: 'thesis-1', name: 'Renamed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.update('crit-1', { name: 'Renamed' });

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('update throws when no row matches', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    await expect(repo.update('missing', {})).rejects.toThrow(/not found/);
  });

  it('delete scopes the write via the investment_thesis subquery', async () => {
    await repo.delete('crit-1');
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it("a repository bound to a different workspace cannot find another workspace's criteria", async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new CriteriaRepository(dbA as never, 'workspace-a');
      const repoB = new CriteriaRepository(dbB as never, 'workspace-b');

      dbA.orderBy.mockResolvedValueOnce([{ id: 'crit-1', investment_thesis_id: 'thesis-1' }]);
      dbB.orderBy.mockResolvedValueOnce([]);

      expect(await repoA.findAll()).toHaveLength(1);
      expect(await repoB.findAll()).toHaveLength(0);
    });
  });
});
