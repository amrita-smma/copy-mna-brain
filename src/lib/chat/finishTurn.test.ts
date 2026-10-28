import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

const {
  withBackgroundDbMock,
  createContainerMock,
  publishReplyMock,
  summarizeThreadAheadMock,
  extractLastTurnMock,
} = vi.hoisted(() => ({
  // Runs the callback against the same container double every call uses.
  withBackgroundDbMock: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
  createContainerMock: vi.fn(),
  publishReplyMock: vi.fn(async () => undefined),
  summarizeThreadAheadMock: vi.fn(async () => 'nothing_to_do'),
  extractLastTurnMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ withBackgroundDb: withBackgroundDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/bots/presence', () => ({ publishReply: publishReplyMock }));
vi.mock('@/lib/bots/summarizeAhead', () => ({ summarizeThreadAhead: summarizeThreadAheadMock }));
vi.mock('@/lib/bots/runBotTurn', () => ({ turnToolNames: () => ['web_search'] }));
vi.mock('@/lib/agents/analysis', () => ({ extractLastTurn: extractLastTurnMock }));

import { finishTurn, type FinishTurnInput } from './finishTurn';

const CHAT = { id: 'chat-1', user_id: 'u1', bot_id: 'bot-1', history_imported_at: null };
const QUESTION = { id: 'q-1', turn: { model: 'claude-sonnet-5-5', effortTier: 'low' as const }, written: true };

describe('finishTurn', () => {
  const getThreadSnapshot = vi.fn();
  const replaceMessagesIfAt = vi.fn();
  const persistTurn = vi.fn();
  const discardQuestion = vi.fn();
  const releaseTurn = vi.fn();
  const claimTurn = vi.fn();
  const dispatchMentions = vi.fn();
  const record = vi.fn();
  const rememberTurn = vi.fn();
  const presence = { setPhase: vi.fn(), done: vi.fn(async () => undefined) };

  const finished = (messages: unknown[]) => ({ messages, hasInterrupt: false, checkpointId: 'cp-2' });
  const input = (over: Partial<FinishTurnInput> = {}): FinishTurnInput => ({
    agent: { getThreadSnapshot, replaceMessagesIfAt },
    workspaceId: 'ws-1',
    userId: 'u1',
    bot: { id: 'bot-1', name: 'Copilot' },
    chat: CHAT,
    turnId: 'turn-1',
    question: QUESTION,
    priorLastHumanId: 'h-old',
    userPinged: ['bot-2'],
    memoryAllowed: true,
    presence,
    ...over,
  });

  beforeEach(() => {
    withBackgroundDbMock.mockClear();
    publishReplyMock.mockClear();
    summarizeThreadAheadMock.mockReset().mockResolvedValue('nothing_to_do');
    extractLastTurnMock.mockReset().mockReturnValue({ userText: 'q', assistantText: 'a' });
    getThreadSnapshot
      .mockReset()
      .mockResolvedValue(finished([new HumanMessage({ id: 'h-new', content: 'q' }), new AIMessage('a')]));
    replaceMessagesIfAt.mockReset();
    persistTurn.mockReset().mockResolvedValue(undefined);
    discardQuestion.mockReset().mockResolvedValue(undefined);
    releaseTurn.mockReset().mockResolvedValue(undefined);
    claimTurn.mockReset().mockResolvedValue(true);
    dispatchMentions.mockReset().mockResolvedValue([]);
    record.mockReset().mockResolvedValue(undefined);
    rememberTurn.mockReset().mockResolvedValue(1);
    presence.done.mockClear();
    createContainerMock.mockReset().mockReturnValue({
      chatHistoryService: { persistTurn, discardQuestion },
      copilotChatsService: { releaseTurn, claimTurn },
      botService: { dispatchMentions },
      botTaskLogService: { record },
      userMemoryService: () => ({ rememberTurn }),
    });
  });

  it('stores the turn as read, announces it, and releases the lock before the presence clears', async () => {
    await finishTurn(input());

    expect(persistTurn).toHaveBeenCalledWith({
      chat: CHAT,
      finalMessages: (await getThreadSnapshot.mock.results[0].value).messages,
      interactive: true,
      questionStored: true,
      question: { id: 'q-1', turn: QUESTION.turn },
    });
    expect(publishReplyMock).toHaveBeenCalledWith('ws-1', 'u1', { chatId: 'chat-1', botId: 'bot-1', turnId: 'turn-1' });
    expect(releaseTurn).toHaveBeenCalledWith('chat-1');
    expect(presence.done).toHaveBeenCalledTimes(1);
    expect(releaseTurn.mock.invocationCallOrder[0]).toBeGreaterThan(persistTurn.mock.invocationCallOrder[0]);
    expect(presence.done.mock.invocationCallOrder[0]).toBeGreaterThan(releaseTurn.mock.invocationCallOrder[0]);
  });

  it('records what the turn established off the lock, slowest last', async () => {
    await finishTurn(input());

    expect(dispatchMentions).toHaveBeenCalledWith('u1', {
      bot: { id: 'bot-1', name: 'Copilot' },
      replyText: 'a',
      alreadyPinged: ['bot-2'],
      chatId: 'chat-1',
      turnId: 'turn-1',
    });
    expect(record).toHaveBeenCalledWith({
      botId: 'bot-1',
      userId: 'u1',
      chatId: 'chat-1',
      source: 'chat',
      routine: null,
      question: 'q',
      answer: 'a',
      toolNames: ['web_search'],
    });
    expect(rememberTurn).toHaveBeenCalledWith({ userId: 'u1', chatId: 'chat-1', userText: 'q', assistantText: 'a' });
    expect(summarizeThreadAheadMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', known: await getThreadSnapshot.mock.results[0].value }),
    );
    const order = [dispatchMentions, record, rememberTurn, summarizeThreadAheadMock].map(
      (fn) => fn.mock.invocationCallOrder[0],
    );
    expect(releaseTurn.mock.invocationCallOrder[0]).toBeLessThan(order[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('stores the question under its id when the up-front write had failed', async () => {
    await finishTurn(input({ question: { ...QUESTION, written: false } }));

    expect(persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({ questionStored: false, question: { id: 'q-1', turn: QUESTION.turn } }),
    );
  });

  it('stores nothing and takes the question back when the turn never reached the thread', async () => {
    getThreadSnapshot.mockResolvedValue(finished([new HumanMessage({ id: 'h-old', content: 'old' })]));

    await finishTurn(input());

    expect(persistTurn).not.toHaveBeenCalled();
    expect(discardQuestion).toHaveBeenCalledWith('q-1');
    expect(releaseTurn).toHaveBeenCalledWith('chat-1');
    expect(presence.done).toHaveBeenCalledTimes(1);
    expect(dispatchMentions).not.toHaveBeenCalled();
    expect(summarizeThreadAheadMock).not.toHaveBeenCalled();
  });

  it('leaves a question that was never written alone', async () => {
    getThreadSnapshot.mockResolvedValue(finished([new HumanMessage({ id: 'h-old', content: 'old' })]));

    await finishTurn(input({ question: { ...QUESTION, written: false } }));

    expect(discardQuestion).not.toHaveBeenCalled();
  });

  it('releases the lock even when the thread cannot be read, and records nothing', async () => {
    getThreadSnapshot.mockRejectedValue(new Error('checkpoint down'));

    await finishTurn(input());

    expect(persistTurn).not.toHaveBeenCalled();
    expect(releaseTurn).toHaveBeenCalledWith('chat-1');
    expect(presence.done).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('still releases the lock and records the turn when the history write fails', async () => {
    persistTurn.mockRejectedValue(new Error('db down'));

    await finishTurn(input());

    expect(publishReplyMock).not.toHaveBeenCalled();
    expect(releaseTurn).toHaveBeenCalledWith('chat-1');
    expect(record).toHaveBeenCalled();
  });

  it('skips the memory write-back when memory is off or the reply is empty', async () => {
    await finishTurn(input({ memoryAllowed: false }));
    expect(rememberTurn).not.toHaveBeenCalled();

    extractLastTurnMock.mockReturnValue({ userText: 'q', assistantText: '   ' });
    await finishTurn(input());
    expect(rememberTurn).not.toHaveBeenCalled();
  });

  it('survives a failure in any off-lock step and goes on to the next', async () => {
    dispatchMentions.mockRejectedValue(new Error('mentions down'));
    record.mockRejectedValue(new Error('jobs down'));
    rememberTurn.mockRejectedValue(new Error('mem0 down'));
    summarizeThreadAheadMock.mockRejectedValue(new Error('summarizer down'));

    await expect(finishTurn(input())).resolves.toBeUndefined();

    expect(record).toHaveBeenCalled();
    expect(rememberTurn).toHaveBeenCalled();
    expect(summarizeThreadAheadMock).toHaveBeenCalled();
  });
});
