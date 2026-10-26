import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { copilotResponseFeedback } from '@/lib/db/schema';
import { CopilotResponseFeedbackRepository } from './copilotResponseFeedbackRepository';

const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
};

const mockDb = {
  insert: vi.fn().mockReturnValue(insertChain),
  select: vi.fn().mockReturnValue(selectChain),
};

const vote = {
  userId: 'user-1',
  chatId: 'chat-1',
  messageId: 'q-1',
  botId: 'bot-1',
  traceId: 'q-1',
  model: 'claude-sonnet-5-5',
  effortTier: 'medium',
  rating: -1,
  reasons: ['shallow'],
  comment: 'too thin',
};

describe('CopilotResponseFeedbackRepository.upsert', () => {
  let repo: CopilotResponseFeedbackRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.insert.mockReturnValue(insertChain);
    insertChain.values.mockReturnThis();
    insertChain.onConflictDoUpdate.mockReturnThis();
    repo = new CopilotResponseFeedbackRepository(mockDb as never, 'workspace-1');
  });

  it('inserts the vote scoped to the repo workspace, with the turn facts', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'f1' }]);

    const row = await repo.upsert(vote);

    expect(mockDb.insert).toHaveBeenCalledWith(copilotResponseFeedback);
    expect(insertChain.values).toHaveBeenCalledWith({
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      chat_id: 'chat-1',
      message_id: 'q-1',
      bot_id: 'bot-1',
      trace_id: 'q-1',
      model: 'claude-sonnet-5-5',
      effort_tier: 'medium',
      rating: -1,
      reasons: ['shallow'],
      comment: 'too thin',
    });
    expect(row).toEqual({ id: 'f1' });
  });

  it("replaces only the vote on the user's existing row for the turn", async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'f1' }]);

    await repo.upsert(vote);

    const conflict = insertChain.onConflictDoUpdate.mock.calls[0][0];
    expect(conflict.target).toEqual([copilotResponseFeedback.user_id, copilotResponseFeedback.message_id]);
    expect(Object.keys(conflict.set).sort()).toEqual(['comment', 'rating', 'reasons', 'updated_at']);
    expect(conflict.set).toMatchObject({ rating: -1, reasons: ['shallow'], comment: 'too thin' });
  });
});

describe('CopilotResponseFeedbackRepository.findByMessageIds', () => {
  let repo: CopilotResponseFeedbackRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnThis();
    selectChain.where.mockReturnThis();
    repo = new CopilotResponseFeedbackRepository(mockDb as never, 'workspace-1');
  });

  it('returns [] without hitting the DB when the id list is empty', async () => {
    expect(await repo.findByMessageIds('user-1', [])).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("reads the user's votes on the given turns in this workspace, ordered by turn", async () => {
    selectChain.orderBy.mockResolvedValueOnce([{ id: 'f1' }]);

    const rows = await repo.findByMessageIds('user-1', ['q-1', 'q-2']);

    expect(selectChain.where).toHaveBeenCalledWith(
      and(
        eq(copilotResponseFeedback.workspace_id, 'workspace-1'),
        eq(copilotResponseFeedback.user_id, 'user-1'),
        inArray(copilotResponseFeedback.message_id, ['q-1', 'q-2']),
      ),
    );
    expect(selectChain.orderBy).toHaveBeenCalledWith(asc(copilotResponseFeedback.message_id));
    expect(rows).toEqual([{ id: 'f1' }]);
  });
});
