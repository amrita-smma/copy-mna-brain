import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AlphasenseToolCallRepository,
  DEFAULT_ALPHASENSE_TOOL_CALL_LIST_LIMIT,
} from './alphasenseToolCallRepository';

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
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
}

describe('AlphasenseToolCallRepository.create', () => {
  let mockDb: MockDb;
  let repo: AlphasenseToolCallRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new AlphasenseToolCallRepository(mockDb as never, 'workspace-a');
  });

  it('stamps the constructor workspace_id onto the inserted row', async () => {
    const row = { id: 'call-1', workspace_id: 'workspace-a', prompt: 'Apple Q4?', status: 'success' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create({
      prompt: 'Apple Q4?',
      status: 'success',
      chat_thread_id: 'thread-1',
      original_question: 'What were Apple Q4 results?',
    });

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({
      prompt: 'Apple Q4?',
      status: 'success',
      chat_thread_id: 'thread-1',
      original_question: 'What were Apple Q4 results?',
      workspace_id: 'workspace-a',
    });
  });
});

describe('AlphasenseToolCallRepository.listByChatThreadId', () => {
  let mockDb: MockDb;
  let repo: AlphasenseToolCallRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new AlphasenseToolCallRepository(mockDb as never, 'workspace-a');
  });

  it('returns rows ordered most-recent-first, scoped to the thread and workspace', async () => {
    const rows = [{ id: 'call-2' }, { id: 'call-1' }];
    mockDb.limit.mockResolvedValueOnce(rows);

    const result = await repo.listByChatThreadId('thread-1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    expect(mockDb.limit).toHaveBeenCalledWith(DEFAULT_ALPHASENSE_TOOL_CALL_LIST_LIMIT);
  });

  it('applies limit and offset when provided', async () => {
    mockDb.offset.mockResolvedValueOnce([]);

    await repo.listByChatThreadId('thread-1', { limit: 10, offset: 5 });

    expect(mockDb.limit).toHaveBeenCalledWith(10);
    expect(mockDb.offset).toHaveBeenCalledWith(5);
  });

  it('a repository bound to workspace-b never resolves workspace-a rows', async () => {
    const dbA = makeMockDb();
    const dbB = makeMockDb();
    const repoA = new AlphasenseToolCallRepository(dbA as never, 'workspace-a');
    const repoB = new AlphasenseToolCallRepository(dbB as never, 'workspace-b');

    dbA.limit.mockResolvedValueOnce([{ id: 'call-1', workspace_id: 'workspace-a' }]);
    dbB.limit.mockResolvedValueOnce([]);

    const resultA = await repoA.listByChatThreadId('thread-1');
    const resultB = await repoB.listByChatThreadId('thread-1');

    expect(resultA).toEqual([{ id: 'call-1', workspace_id: 'workspace-a' }]);
    expect(resultB).toEqual([]);
  });
});

describe('AlphasenseToolCallRepository.listRecent', () => {
  let mockDb: MockDb;
  let repo: AlphasenseToolCallRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new AlphasenseToolCallRepository(mockDb as never, 'workspace-a');
  });

  it('returns rows scoped to the workspace without a thread filter', async () => {
    const rows = [{ id: 'call-1' }];
    mockDb.limit.mockResolvedValueOnce(rows);

    const result = await repo.listRecent();

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    expect(mockDb.limit).toHaveBeenCalledWith(DEFAULT_ALPHASENSE_TOOL_CALL_LIST_LIMIT);
  });

  it('applies an explicit limit and offset when provided', async () => {
    mockDb.offset.mockResolvedValueOnce([]);

    await repo.listRecent({ limit: 20, offset: 40 });

    expect(mockDb.limit).toHaveBeenCalledWith(20);
    expect(mockDb.offset).toHaveBeenCalledWith(40);
  });
});
