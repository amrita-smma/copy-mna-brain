import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotChatsRepository } from './copilotChatsRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
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
      offset: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    repo = new CopilotChatsRepository(mockDb as never, 'workspace-1');
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
    // No page requested → no LIMIT/OFFSET clause at all.
    expect(mockDb.limit).not.toHaveBeenCalled();
    expect(mockDb.offset).not.toHaveBeenCalled();
  });

  // last_active_at alone is not unique: chats touched in the same transaction
  // share a timestamp, and without a tiebreak Postgres may order them
  // differently per query — the same row would appear on two pages while
  // another never appears at all.
  it('listByUser breaks ties on id so paging cannot duplicate or skip a row', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.listByUser('u1');

    expect(mockDb.orderBy.mock.calls[0]).toHaveLength(2);
  });

  it('listByUser applies limit and offset when a page is requested', async () => {
    const rows = [{ id: 'c3', user_id: 'u1' }];
    mockDb.orderBy.mockReturnThis();
    mockDb.limit.mockReturnThis();
    mockDb.offset.mockResolvedValueOnce(rows);

    const result = await repo.listByUser('u1', { limit: 31, offset: 30 });

    expect(result).toEqual(rows);
    expect(mockDb.limit).toHaveBeenCalledWith(31);
    expect(mockDb.offset).toHaveBeenCalledWith(30);
  });

  it('listByUser skips the OFFSET clause for the first page', async () => {
    const rows = [{ id: 'c1', user_id: 'u1' }];
    mockDb.orderBy.mockReturnThis();
    mockDb.limit.mockResolvedValueOnce(rows);

    const result = await repo.listByUser('u1', { limit: 31, offset: 0 });

    expect(result).toEqual(rows);
    expect(mockDb.limit).toHaveBeenCalledWith(31);
    expect(mockDb.offset).not.toHaveBeenCalled();
  });

  it('create returns the inserted row', async () => {
    const row = { id: 'c1', user_id: 'u1', title: null };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create('u1');

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ user_id: 'u1', workspace_id: 'workspace-1' });
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

  it('setEffortTier pins the tier the thread runs at', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.setEffortTier('c1', 'high');

    expect(mockDb.set).toHaveBeenCalledWith({ effort_tier: 'high' });
  });

  it('recordFirstMessage writes the message and hash', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.recordFirstMessage('c1', 'Hello there', 'abc123');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({
      first_user_message: 'Hello there',
      first_user_message_hash: 'abc123',
    });
  });

  it('findLatestFirstMessageMatch returns the most recent match', async () => {
    const row = { id: 'c1', first_user_message_hash: 'abc123' };
    mockDb.orderBy.mockReturnThis();
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findLatestFirstMessageMatch('abc123', 'general');

    expect(result).toEqual(row);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });

  it('findLatestFirstMessageMatch returns null when there is no match', async () => {
    mockDb.orderBy.mockReturnThis();
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.findLatestFirstMessageMatch('nohash', 'bangun');

    expect(result).toBeNull();
  });

  it('create pre-pins the agent key when one is given', async () => {
    mockDb.returning.mockResolvedValueOnce([{ id: 'c1', agent_key: 'bangun' }]);

    await repo.create('u1', 'bangun');

    expect(mockDb.values).toHaveBeenCalledWith({
      user_id: 'u1',
      workspace_id: 'workspace-1',
      agent_key: 'bangun',
    });
  });

  it('pinAgentKey writes the key and returns it when the thread was unresolved', async () => {
    mockDb.returning.mockResolvedValueOnce([{ agent_key: 'bangun' }]);

    const result = await repo.pinAgentKey('c1', 'bangun');

    expect(result).toBe('bangun');
    expect(mockDb.set).toHaveBeenCalledWith({ agent_key: 'bangun' });
    // Lost-race fallback read not needed.
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('pinAgentKey keeps and returns the stored key when the thread is already pinned', async () => {
    // The guarded UPDATE matches no row …
    mockDb.returning.mockResolvedValueOnce([]);
    // … so the stored key is read back.
    mockDb.limit.mockResolvedValueOnce([{ agent_key: 'general' }]);

    const result = await repo.pinAgentKey('c1', 'bangun');

    expect(result).toBe('general');
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('pinAgentKey returns null when the chat is not in this workspace', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(repo.pinAgentKey('missing', 'bangun')).resolves.toBeNull();
  });
});
