import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createContainer, store } = vi.hoisted(() => ({ createContainer: vi.fn(), store: vi.fn() }));
vi.mock('@/lib/services/container', () => ({ createContainer }));

import { runBotTaskSummary } from './botTaskSummary';

const entry = {
  botId: 'b1',
  userId: 'u1',
  chatId: 'c1',
  source: 'chat' as const,
  routine: null,
  question: 'Find targets',
  answer: 'Found three.',
  toolNames: ['query_companies'],
};

describe('runBotTaskSummary', () => {
  beforeEach(() => {
    store.mockReset();
    createContainer.mockReset().mockReturnValue({ botTaskLogService: { store } });
  });

  it("summarizes the turn and adds it to the bot's task log in the job's workspace", async () => {
    const summarize = vi.fn(async () => 'Found three fintech targets');
    expect(await runBotTaskSummary({ db: {} as never, workspaceId: 'ws-9', entry }, summarize)).toEqual({ logged: true });
    expect(summarize).toHaveBeenCalledWith({
      question: 'Find targets',
      answer: 'Found three.',
      toolNames: ['query_companies'],
      routineTitle: null,
    });
    expect(createContainer).toHaveBeenCalledWith({}, 'ws-9');
    expect(store).toHaveBeenCalledWith(entry, 'Found three fintech targets');
  });

  it('logs nothing for small talk', async () => {
    expect(await runBotTaskSummary({ db: {} as never, workspaceId: 'ws-9', entry }, async () => null)).toEqual({
      logged: false,
    });
    expect(store).not.toHaveBeenCalled();
  });
});
