import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceRepository } from './workspaceRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

describe('WorkspaceRepository', () => {
  let mockDb: MockDb;
  let repo: WorkspaceRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    repo = new WorkspaceRepository(mockDb as never);
  });

  it('findAll returns every workspace', async () => {
    const rows = [{ id: 'w1', name: 'MNA', slug: 'mna' }];
    mockDb.from.mockResolvedValueOnce(rows);

    const result = await repo.findAll();

    expect(result).toEqual(rows);
  });

  it('findById returns the matching row', async () => {
    const row = { id: 'w1', name: 'MNA', slug: 'mna' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findById('w1');

    expect(result).toEqual(row);
  });

  it('insert returns the inserted row', async () => {
    const row = { id: 'w1', name: 'MNA', slug: 'mna' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ name: 'MNA', slug: 'mna' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ name: 'MNA', slug: 'mna' });
  });

  it('update returns the updated row', async () => {
    const row = { id: 'w1', name: 'Renamed', slug: 'mna' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.update('w1', { name: 'Renamed' });

    expect(result).toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith({ name: 'Renamed' });
  });
});
