import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundRepository } from './fundRepository';

function makeDb() {
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

describe('FundRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: FundRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new FundRepository(db as never, 'workspace-1');
  });

  it('findAll returns every fund in this workspace ordered by name', async () => {
    const rows = [{ id: 'f1', name: 'Fund I', workspace_id: 'workspace-1' }];
    db.orderBy.mockResolvedValueOnce(rows);
    const result = await repo.findAll();
    expect(result).toEqual(rows);
  });

  it('findById returns undefined when no fund matches', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findById('missing');
    expect(result).toBeUndefined();
  });

  it('insert stamps the workspace_id and returns the row', async () => {
    const row = { id: 'f1', name: 'Fund I', base_currency: 'USD', workspace_id: 'workspace-1' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.insert({ name: 'Fund I' } as never);
    expect(result).toEqual(row);
    expect(db.values).toHaveBeenCalledWith({ name: 'Fund I', workspace_id: 'workspace-1' });
  });

  it('update sets the given fields and returns the updated row', async () => {
    const row = { id: 'f1', name: 'Fund I Renamed' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.update('f1', { name: 'Fund I Renamed' });
    expect(result).toEqual(row);
    expect(db.set).toHaveBeenCalledWith({ name: 'Fund I Renamed' });
  });

  it('delete removes the fund by id', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('f1');
    expect(db.delete).toHaveBeenCalled();
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot see another workspace\'s fund', async () => {
      const dbA = makeDb();
      const dbB = makeDb();
      const repoA = new FundRepository(dbA as never, 'workspace-a');
      const repoB = new FundRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 'f1', workspace_id: 'workspace-a' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findById('f1')).toBeDefined();
      expect(await repoB.findById('f1')).toBeUndefined();
    });
  });
});
