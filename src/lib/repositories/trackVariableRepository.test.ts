import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrackVariableRepository } from './trackVariableRepository';

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

describe('TrackVariableRepository', () => {
  let mockDb: MockDb;
  let repo: TrackVariableRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new TrackVariableRepository(mockDb as never, 'workspace-a');
  });

  it('findAll scopes to tracks in this workspace when no trackId is given', async () => {
    const rows = [{ id: 'tv1', track_id: 'track-1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findAll();

    expect(result).toEqual(rows);
    // One where() for the investment_thesis subquery, one for the outer query.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findAll additionally filters by trackId when given', async () => {
    const rows = [{ id: 'tv1', track_id: 'track-1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findAll('track-1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('insert writes the row without stamping a workspace_id', async () => {
    const row = { id: 'tv1', track_id: 'track-1', name: 'ARR' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ track_id: 'track-1', name: 'ARR' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ track_id: 'track-1', name: 'ARR' });
  });

  it('update scopes the write via the investment_thesis subquery', async () => {
    const row = { id: 'tv1', track_id: 'track-1', name: 'Renamed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.update('tv1', { name: 'Renamed' } as never);

    expect(result).toEqual(row);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('update throws when no row matches', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    await expect(repo.update('missing', {} as never)).rejects.toThrow(/not found/);
  });

  it('delete scopes the write via the investment_thesis subquery', async () => {
    await repo.delete('tv1');
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot find another workspace\'s track variables', async () => {
      const dbA = makeMockDb();
      const dbB = makeMockDb();
      const repoA = new TrackVariableRepository(dbA as never, 'workspace-a');
      const repoB = new TrackVariableRepository(dbB as never, 'workspace-b');

      dbA.orderBy.mockResolvedValueOnce([{ id: 'tv1', track_id: 'track-1' }]);
      dbB.orderBy.mockResolvedValueOnce([]);

      expect(await repoA.findAll()).toHaveLength(1);
      expect(await repoB.findAll()).toHaveLength(0);
    });
  });
});
