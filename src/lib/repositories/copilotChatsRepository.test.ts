import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotChatsRepository } from './copilotChatsRepository';

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
}

describe('CopilotChatsRepository', () => {
  let mockDb: MockDb;
  let repo: CopilotChatsRepository;

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
    };
    repo = new CopilotChatsRepository(mockDb as never);
  });

  it('listByUser returns rows ordered by last_active_at desc', async () => {
    const rows = [
      { id: 'c1', user_id: 'u1', title: 'A', last_active_at: '2026-05-08' },
      { id: 'c2', user_id: 'u1', title: 'B', last_active_at: '2026-05-07' },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.listByUser('u1');

    expect(result).toEqual(rows);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('create returns the inserted row', async () => {
    const row = { id: 'c1', user_id: 'u1', title: null };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create('u1');

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ user_id: 'u1' });
  });

  it('getById returns the row when found', async () => {
    const row = { id: 'c1', user_id: 'u1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.getById('c1');

    expect(result).toEqual(row);
  });

  it('getById returns null when not found', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.getById('missing');

    expect(result).toBeNull();
  });

  it('touchLastActive issues an update with sql now()', async () => {
    mockDb.set.mockReturnThis();
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.touchLastActive('c1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledTimes(1);
  });

  it('setTitle writes the title', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.setTitle('c1', 'My title');

    expect(mockDb.set).toHaveBeenCalledWith({ title: 'My title' });
  });
});
