import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HoldingEntityRepository } from './holdingEntityRepository';

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

describe('HoldingEntityRepository', () => {
  let mockDb: MockDb;
  let repo: HoldingEntityRepository;

  beforeEach(() => {
    mockDb = {
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
    repo = new HoldingEntityRepository(mockDb as never, 'workspace-1');
  });

  it('findAll returns rows scoped to the workspace', async () => {
    const rows = [{ id: 'i1', name: 'Startech Growth Fund 1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    expect(await repo.findAll()).toEqual(rows);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('findById returns the row when found', async () => {
    const row = { id: 'i1', name: 'Meranti Global Investment Ltd' };
    mockDb.limit.mockResolvedValueOnce([row]);

    expect(await repo.findById('i1')).toEqual(row);
  });

  it('findById returns undefined when not found', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    expect(await repo.findById('missing')).toBeUndefined();
  });

  it('insert forces the repo workspace_id regardless of input', async () => {
    const row = { id: 'i1', name: 'New Entity', workspace_id: 'workspace-1' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ name: 'New Entity' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ name: 'New Entity', workspace_id: 'workspace-1' });
  });

  it('update returns the updated row', async () => {
    const row = { id: 'i1', name: 'Renamed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    expect(await repo.update('i1', { name: 'Renamed' })).toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith({ name: 'Renamed' });
  });

  it('delete issues a delete', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);
    await repo.delete('i1');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });
});
