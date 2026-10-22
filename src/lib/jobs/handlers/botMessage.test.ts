import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  createContainer: vi.fn(),
  findUser: vi.fn(),
  getAgentGraph: vi.fn(),
  runBotTurn: vi.fn(),
  flushLangfuse: vi.fn(),
  copilotMemoryEnabled: vi.fn(async () => true),
  recallForTurn: vi.fn(async () => '## What you remember about this user\n\n- Covers coal'),
  workspaceDuring: [] as (string | undefined)[],
}));

vi.mock('@/lib/services/container', () => ({ createContainer: m.createContainer }));
vi.mock('@/lib/repositories', () => ({
  UserRepository: class {
    findById = m.findUser;
  },
}));
vi.mock('@/lib/agents/analysis/graphs', () => ({ getAgentGraph: m.getAgentGraph }));
vi.mock('@/lib/flags', () => ({ sourceOfFundsEnabled: vi.fn(async () => true), copilotMemoryEnabled: m.copilotMemoryEnabled }));
vi.mock('@/lib/langfuse', () => ({ flushLangfuse: m.flushLangfuse }));
vi.mock('@/lib/bots/runBotTurn', () => ({ runBotTurn: m.runBotTurn }));

import { runBotMessage } from './botMessage';
import { getActiveWorkspaceId } from '@/lib/workspace';

describe('runBotMessage', () => {
  const services = {
    botService: { openThread: vi.fn(), mentionContext: vi.fn(), dispatchMentions: vi.fn() },
    botTaskLogService: { record: vi.fn() },
    botRequestService: { close: vi.fn() },
    chatService: { buildContext: vi.fn() },
    copilotChatsService: { claimTurn: vi.fn(), releaseTurn: vi.fn() },
    chatHistoryService: { persistTurn: vi.fn() },
    userMemoryService: vi.fn(() => ({ recallForTurn: m.recallForTurn })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    m.createContainer.mockReturnValue(services);
    services.botService.openThread.mockResolvedValue({ bot: { id: 'scout', name: 'Deal Scout' }, chat: { id: 'chat-1' } });
    services.botService.mentionContext.mockResolvedValue('<other_bots>');
    services.botService.dispatchMentions.mockResolvedValue([]);
    services.botTaskLogService.record.mockResolvedValue(undefined);
    services.botRequestService.close.mockResolvedValue({ closed: true, repliedTo: null });
    m.findUser.mockResolvedValue({ email: 'a@b.c', name: 'A' });
    m.runBotTurn.mockImplementation(async () => {
      m.workspaceDuring.push(await getActiveWorkspaceId());
      return { userText: 'q', answerText: 'Ask @Atlas.', toolNames: [] };
    });
  });

  it("runs the target bot's turn on the user's thread, inside the job's workspace", async () => {
    const result = await runBotMessage({
      db: {} as never,
      workspaceId: 'ws-9',
      userId: 'u1',
      origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
      toBotId: 'scout',
      text: 'Find targets',
    });

    expect(result).toEqual({ chatId: 'chat-1' });
    expect(m.createContainer).toHaveBeenCalledWith({}, 'ws-9');
    expect(services.botService.openThread).toHaveBeenCalledWith('u1', 'scout');
    expect(m.runBotTurn.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-9',
      bot: { id: 'scout', name: 'Deal Scout' },
      chat: { id: 'chat-1' },
      user: { id: 'u1', email: 'a@b.c', name: 'A' },
      origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
      text: 'Find targets',
      extraContext: '',
    });
    expect(services.botService.mentionContext).not.toHaveBeenCalled();
    // A reply to a mention hands nothing on: chains are one hop deep.
    expect(services.botService.dispatchMentions).not.toHaveBeenCalled();
    expect(services.botTaskLogService.record).toHaveBeenCalledWith({
      botId: 'scout',
      userId: 'u1',
      chatId: 'chat-1',
      source: 'mention',
      routine: null,
      question: 'q',
      answer: 'Ask @Atlas.',
      toolNames: [],
    });
    // Tools resolve the workspace from the job, not the default workspace.
    expect(m.workspaceDuring).toContain('ws-9');
    expect(m.flushLangfuse).toHaveBeenCalled();
  });

  it('loads @mention delegation context only for a routine turn', async () => {
    await runBotMessage({
      db: {} as never,
      workspaceId: 'ws-9',
      userId: 'u1',
      origin: { kind: 'routine', routine: { id: 'r1', title: 'Daily' } },
      toBotId: 'scout',
      text: 'Summarise',
    });
    expect(services.botService.mentionContext).toHaveBeenCalledWith('u1', 'scout');
    expect(m.runBotTurn.mock.calls[0][0].extraContext).toBe('<other_bots>');
  });

  it("hands on the bots a routine turn's reply @mentions", async () => {
    await runBotMessage({
      db: {} as never,
      workspaceId: 'ws-9',
      userId: 'u1',
      origin: { kind: 'routine', routine: { id: 'r1', title: 'Daily' } },
      toBotId: 'scout',
      text: 'Summarise',
    });
    expect(services.botService.dispatchMentions).toHaveBeenCalledWith('u1', {
      bot: { id: 'scout', name: 'Deal Scout' },
      replyText: 'Ask @Atlas.',
      chatId: 'chat-1',
      turnId: undefined,
    });
    expect(services.botTaskLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'routine', routine: { id: 'r1', title: 'Daily' } }),
    );
  });

  describe('the request behind a bot_mention', () => {
    const job = {
      db: {} as never,
      workspaceId: 'ws-9',
      userId: 'u1',
      origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
      toBotId: 'scout',
      text: 'Find targets',
      requestId: 'req-1',
    } as const;

    it('closes it with the answer once the turn is done', async () => {
      await runBotMessage(job);
      expect(services.botRequestService.close).toHaveBeenCalledWith('req-1', { answer: 'Ask @Atlas.' });
    });

    it('closes it with the failure when the turn throws, then rethrows', async () => {
      m.runBotTurn.mockRejectedValueOnce(new Error('anthropic 529'));
      await expect(runBotMessage(job)).rejects.toThrow('anthropic 529');
      expect(services.botRequestService.close).toHaveBeenCalledWith('req-1', { failure: 'anthropic 529' });
    });

    it('survives a failed close, and closes nothing for a message with no request', async () => {
      services.botRequestService.close.mockRejectedValueOnce(new Error('db down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(runBotMessage(job)).resolves.toEqual({ chatId: 'chat-1' });
      expect(error).toHaveBeenCalled();
      error.mockRestore();

      services.botRequestService.close.mockClear();
      await runBotMessage({ ...job, requestId: undefined });
      expect(services.botRequestService.close).not.toHaveBeenCalled();
    });
  });
});
