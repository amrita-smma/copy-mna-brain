import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiChatConversationRepository } from './apiChatConversationRepository';

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

describe('ApiChatConversationRepository', () => {
  let mockDb: MockDb;
  let repo: ApiChatConversationRepository;

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
    repo = new ApiChatConversationRepository(mockDb as never, 'workspace-1');
  });

  it('listByApiKey returns rows ordered by last_active_at desc', async () => {
    const rows = [{ id: 'c1', api_key_id: 'k1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.listByApiKey('k1');

    expect(result).toEqual(rows);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('create returns the inserted row scoped to the api key', async () => {
    const row = { id: 'c1', api_key_id: 'k1', title: null };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create('k1');

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ api_key_id: 'k1', workspace_id: 'workspace-1' });
  });

  it('getByIdForApiKey returns the row when found', async () => {
    const row = { id: 'c1', api_key_id: 'k1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.getByIdForApiKey('c1', 'k1');

    expect(result).toEqual(row);
  });

  it('getByIdForApiKey returns null when not found or owned by another key', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.getByIdForApiKey('c1', 'other');

    expect(result).toBeNull();
  });

  it('touchLastActive issues an update', async () => {
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
