import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CopilotResponseFeedbackService,
  InvalidResponseFeedbackError,
  RESPONSE_FEEDBACK_SCORE_NAME,
  ResponseFeedbackTurnNotFoundError,
  turnTraceId,
} from './copilotResponseFeedbackService';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from './copilotChatsService';

const { upsertMock, findMessageMock, getChatMock, sendScoreMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  findMessageMock: vi.fn(),
  getChatMock: vi.fn(),
  sendScoreMock: vi.fn(),
}));

vi.mock('@/lib/langfuseScore', () => ({ sendLangfuseScore: vi.fn() }));

class MockFeedbackRepo {
  upsert = upsertMock;
}
class MockMessageRepo {
  findById = findMessageMock;
}
class MockChatsRepo {
  getById = getChatMock;
}

const chat = { id: 'chat-1', user_id: 'user-1' };
const question = {
  id: 'q-1',
  chat_id: 'chat-1',
  role: 'user',
  bot_id: 'bot-1',
  model: 'claude-sonnet-5-5',
  effort_tier: 'medium',
};

function service() {
  return new CopilotResponseFeedbackService({
    feedback: new MockFeedbackRepo() as never,
    messages: new MockMessageRepo() as never,
    chats: new MockChatsRepo() as never,
    sendScore: sendScoreMock,
  });
}

const vote = { userId: 'user-1', chatId: 'chat-1', messageId: 'q-1' };

describe('CopilotResponseFeedbackService.submit', () => {
  beforeEach(() => {
    upsertMock.mockReset().mockImplementation(async (input) => ({ id: 'f1', ...input }));
    findMessageMock.mockReset().mockResolvedValue(question);
    getChatMock.mockReset().mockResolvedValue(chat);
    sendScoreMock.mockReset();
  });

  it("stores the vote with the bot, model, tier and trace read from the turn's question row", async () => {
    await service().submit({ ...vote, rating: -1, reasons: ['shallow'], comment: ' thin ' });

    expect(upsertMock).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'q-1',
      botId: 'bot-1',
      traceId: 'q-1',
      model: 'claude-sonnet-5-5',
      effortTier: 'medium',
      rating: -1,
      reasons: ['shallow'],
      comment: 'thin',
    });
  });

  it('rejects an invalid vote before touching the database', async () => {
    await expect(service().submit({ ...vote, rating: 3 })).rejects.toBeInstanceOf(
      InvalidResponseFeedbackError,
    );
    expect(getChatMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('refuses a chat that does not exist', async () => {
    getChatMock.mockResolvedValue(null);
    await expect(service().submit({ ...vote, rating: 1 })).rejects.toBeInstanceOf(CopilotChatNotFoundError);
  });

  it("refuses feedback on another user's chat", async () => {
    getChatMock.mockResolvedValue({ ...chat, user_id: 'someone-else' });
    await expect(service().submit({ ...vote, rating: 1 })).rejects.toBeInstanceOf(CopilotChatForbiddenError);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it.each([
    ['is missing', null],
    ['belongs to another chat', { ...question, chat_id: 'chat-2' }],
    ['is a reply, not a question', { ...question, role: 'assistant' }],
  ])('refuses a turn whose question row %s', async (_label, row) => {
    findMessageMock.mockResolvedValue(row);
    await expect(service().submit({ ...vote, rating: 1 })).rejects.toBeInstanceOf(
      ResponseFeedbackTurnNotFoundError,
    );
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('records no trace for a turn stored before turns were traced by their question', async () => {
    findMessageMock.mockResolvedValue({ ...question, model: null, effort_tier: null });

    await service().submit({ ...vote, rating: 1 });

    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ traceId: null, model: null }));
  });
});

describe('CopilotResponseFeedbackService.scoreInLangfuse', () => {
  const row = {
    id: 'f1',
    chat_id: 'chat-1',
    bot_id: 'bot-1',
    trace_id: 'q-1',
    model: 'claude-sonnet-5-5',
    effort_tier: 'medium',
    rating: -1,
    reasons: ['shallow'],
    comment: 'thin',
  };

  beforeEach(() => sendScoreMock.mockReset().mockResolvedValue(undefined));

  it("scores the turn's trace under the row's id, so a changed vote replaces the score", async () => {
    await service().scoreInLangfuse(row as never);

    expect(sendScoreMock).toHaveBeenCalledWith({
      id: 'f1',
      traceId: 'q-1',
      name: RESPONSE_FEEDBACK_SCORE_NAME,
      value: -1,
      comment: 'thin',
      metadata: {
        reasons: ['shallow'],
        chat_id: 'chat-1',
        bot_id: 'bot-1',
        model: 'claude-sonnet-5-5',
        effort_tier: 'medium',
      },
    });
  });

  it('sends nothing for a turn with no trace, or a comment with no rating', async () => {
    await service().scoreInLangfuse({ ...row, trace_id: null } as never);
    await service().scoreInLangfuse({ ...row, rating: null } as never);
    expect(sendScoreMock).not.toHaveBeenCalled();
  });
});

describe('turnTraceId', () => {
  it("is the question row's id only when the turn ran under it (the row has a model)", () => {
    expect(turnTraceId({ id: 'q-1', model: 'claude-sonnet-5-5' })).toBe('q-1');
    expect(turnTraceId({ id: 'q-1', model: null })).toBeNull();
  });
});
