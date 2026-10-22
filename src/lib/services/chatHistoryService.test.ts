import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatHistoryService } from './chatHistoryService';
import { FROM_BOT_KWARG, FROM_ROUTINE_KWARG } from '@/lib/chat/uiMessages';

const messages = vi.hoisted(() => ({ insertMany: vi.fn(), listPage: vi.fn(), listTurnsPage: vi.fn(), deleteById: vi.fn() }));
const chats = vi.hoisted(() => ({
  claimHistoryImport: vi.fn(),
  stampMessage: vi.fn(),
  getById: vi.fn(),
  clearHistoryImport: vi.fn(),
}));
const dispatchEmbedding = vi.hoisted(() => vi.fn());

const chat = { id: 'chat-1', user_id: 'u1', bot_id: 'bot-1', history_imported_at: '2026-10-14T00:00:00Z' };

function service() {
  return new ChatHistoryService({ messages: messages as never, chats: chats as never, dispatchEmbedding });
}

describe('ChatHistoryService', () => {
  beforeEach(() => {
    for (const fn of [...Object.values(messages), ...Object.values(chats), dispatchEmbedding]) fn.mockReset();
    chats.claimHistoryImport.mockResolvedValue(false);
    chats.getById.mockResolvedValue({ history_imported_at: '2026-10-14T00:00:00Z' });
    chats.clearHistoryImport.mockResolvedValue(undefined);
    messages.insertMany.mockImplementation(async (rows: { role: string }[]) =>
      rows.map((r, i) => ({ id: `m${i}`, role: r.role })),
    );
    dispatchEmbedding.mockResolvedValue({ jobId: 'j' });
    messages.listPage.mockResolvedValue({ rows: [], hasMore: false });
    messages.listTurnsPage.mockResolvedValue({ rows: [], hasMore: false });
  });

  describe('ChatHistoryService.persistTurn', () => {
    const finalMessages = [
      new HumanMessage({ id: 'h0', content: 'old question' }),
      new AIMessage({ id: 'a0', content: 'old answer' }),
      new HumanMessage({ id: 'h1', content: 'How many deals?' }),
      new AIMessage({ id: 'a1', content: 'Twelve.' }),
    ];

    it('stores the latest turn, the reply holding the whole exchange, and queues its embedding', async () => {
      await service().persistTurn({ chat, finalMessages, interactive: true });

      // An imported thread never tries the import again.
      expect(chats.claimHistoryImport).not.toHaveBeenCalled();

      const rows = messages.insertMany.mock.calls[0][0];
      expect(rows).toEqual([
        expect.objectContaining({ chat_id: 'chat-1', user_id: 'u1', bot_id: 'bot-1', role: 'user', text: 'How many deals?' }),
        expect.objectContaining({ role: 'assistant', text: 'Q: How many deals?\n\nA: Twelve.' }),
      ]);
      expect(dispatchEmbedding).toHaveBeenCalledWith(['m1']);
    });

    it('marks an interactive turn read, and leaves a background reply unread', async () => {
      await service().persistTurn({ chat, finalMessages, interactive: true });
      await service().persistTurn({ chat, finalMessages, interactive: false });

      expect(chats.stampMessage.mock.calls).toEqual([
        ['chat-1', { read: true }],
        ['chat-1', { read: false }],
      ]);
    });

    it("imports the whole checkpoint on a thread's first write instead of only the last turn", async () => {
      chats.claimHistoryImport.mockResolvedValue(true);

      await service().persistTurn({ chat: { ...chat, history_imported_at: null }, finalMessages, interactive: true });

      expect(messages.insertMany).toHaveBeenCalledTimes(1);
      expect(messages.insertMany.mock.calls[0][0]).toHaveLength(4);
      expect(dispatchEmbedding).toHaveBeenCalledWith(['m1', 'm3']);
    });

    it('records the sending bot on a message from another bot', async () => {
      await service().persistTurn({
        chat,
        finalMessages: [
          new HumanMessage({ content: 'Find targets', additional_kwargs: { [FROM_BOT_KWARG]: { id: 'copilot', name: 'Copilot' } } }),
          new AIMessage('Here are three.'),
        ],
        interactive: false,
        authorBotId: 'copilot',
      });

      const [user] = messages.insertMany.mock.calls[0][0];
      expect(user.author_bot_id).toBe('copilot');
      expect(user.parts).toContainEqual({ type: 'data-from-bot', data: { id: 'copilot', name: 'Copilot' } });
    });

    it("keeps a user's own @mention authored by the user, and records a routine's message", async () => {
      await service().persistTurn({
        chat,
        finalMessages: [
          new HumanMessage({
            content: '@Scout find targets',
            additional_kwargs: { [FROM_BOT_KWARG]: { id: 'copilot', name: 'Copilot', kind: 'user_mention' } },
          }),
          new AIMessage('On it.'),
        ],
        interactive: false,
        authorBotId: null,
      });
      expect(messages.insertMany.mock.calls[0][0][0].author_bot_id).toBeNull();

      await service().persistTurn({
        chat,
        finalMessages: [
          new HumanMessage({ content: 'Daily', additional_kwargs: { [FROM_ROUTINE_KWARG]: { id: 'r1', title: 'Daily' } } }),
          new AIMessage('Done.'),
        ],
        interactive: false,
      });
      expect(messages.insertMany.mock.calls[1][0][0].parts).toContainEqual({
        type: 'data-from-routine',
        data: { id: 'r1', title: 'Daily' },
      });
    });

    it('stores nothing for a turn with no reply', async () => {
      await service().persistTurn({ chat, finalMessages: [new HumanMessage('hi')], interactive: true });
      expect(messages.insertMany).not.toHaveBeenCalled();
    });

    it('stores only the reply when the question went in at the start, its text still carrying the question', async () => {
      await service().persistTurn({ chat, finalMessages, interactive: true, questionStored: true });

      expect(messages.insertMany.mock.calls[0][0]).toEqual([
        expect.objectContaining({ role: 'assistant', text: 'Q: How many deals?\n\nA: Twelve.' }),
      ]);
      expect(dispatchEmbedding).toHaveBeenCalledWith(['m0']);
      expect(chats.stampMessage).toHaveBeenCalledWith('chat-1', { read: true });
    });

    it('keeps the turn when queuing its embedding fails', async () => {
      dispatchEmbedding.mockRejectedValue(new Error('no AWS'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(service().persistTurn({ chat, finalMessages, interactive: true })).resolves.toBeUndefined();
      expect(chats.stampMessage).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('ChatHistoryService.persistQuestion', () => {
    const question = new HumanMessage({
      content: 'Find targets',
      additional_kwargs: { [FROM_BOT_KWARG]: { id: 'copilot', name: 'Copilot' } },
    });

    it('stores the user row alone, labelled with its sender, without touching the unread flag or embeddings', async () => {
      const id = await service().persistQuestion({ chat, message: question, prior: [], authorBotId: 'copilot' });

      expect(id).toBe('m0');
      const rows = messages.insertMany.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ chat_id: 'chat-1', role: 'user', text: 'Find targets', author_bot_id: 'copilot' });
      expect(rows[0].parts).toContainEqual({ type: 'data-from-bot', data: { id: 'copilot', name: 'Copilot' } });
      expect(dispatchEmbedding).not.toHaveBeenCalled();
      expect(chats.stampMessage).not.toHaveBeenCalled();
      expect(chats.claimHistoryImport).not.toHaveBeenCalled();
    });

    it("imports a thread's earlier turns first, so the question lands after them", async () => {
      chats.claimHistoryImport.mockResolvedValue(true);
      const prior = [new HumanMessage({ id: 'h0', content: 'old question' }), new AIMessage({ id: 'a0', content: 'old answer' })];

      await service().persistQuestion({ chat: { ...chat, history_imported_at: null }, message: new HumanMessage('new?'), prior });

      expect(messages.insertMany).toHaveBeenCalledTimes(2);
      expect(messages.insertMany.mock.calls[0][0].map((r: { text: string }) => r.text)).toEqual([
        'old question',
        'Q: old question\n\nA: old answer',
      ]);
      expect(messages.insertMany.mock.calls[1][0]).toEqual([expect.objectContaining({ role: 'user', text: 'new?' })]);
    });
  });

  describe('ChatHistoryService.discardQuestion', () => {
    it('deletes the row', async () => {
      await service().discardQuestion('m0');
      expect(messages.deleteById).toHaveBeenCalledWith('m0');
    });
  });

  describe('ChatHistoryService.page', () => {
    const row = (seq: number, role: 'user' | 'assistant', parts: unknown[]) => ({
      id: `r${seq}`,
      seq,
      role,
      parts,
      author_bot_id: null,
      created_at: `2026-10-14T09:0${seq}:00.000Z`,
    });

    it('returns stored rows as UI messages, each stamped with when it was stored, with the cursor for the page before them', async () => {
      messages.listTurnsPage.mockResolvedValue({
        rows: [
          row(5, 'user', [
            { type: 'text', text: 'q' },
            { type: 'data-from-bot', data: { id: 'b', name: 'B' } },
          ]),
          row(6, 'assistant', [{ type: 'text', text: 'a' }]),
          row(7, 'user', [
            { type: 'text', text: 'r' },
            { type: 'data-from-routine', data: { id: 'rt', title: 'Daily' } },
          ]),
        ],
        hasMore: true,
      });
      const load = vi.fn();

      const page = await service().page({ ...chat, history_imported_at: '2026-10-14' }, { before: 9 }, load);

      expect(load).not.toHaveBeenCalled();
      expect(messages.listTurnsPage).toHaveBeenCalledWith('chat-1', { before: 9, turns: 5 });
      expect(page).toEqual({
        messages: [
          {
            id: 'r5',
            role: 'user',
            parts: [{ type: 'text', text: 'q' }],
            metadata: { fromBot: { id: 'b', name: 'B' }, createdAt: '2026-10-14T09:05:00.000Z' },
          },
          { id: 'r6', role: 'assistant', parts: [{ type: 'text', text: 'a' }], metadata: { createdAt: '2026-10-14T09:06:00.000Z' } },
          {
            id: 'r7',
            role: 'user',
            parts: [{ type: 'text', text: 'r' }],
            metadata: { fromRoutine: { id: 'rt', title: 'Daily' }, createdAt: '2026-10-14T09:07:00.000Z' },
          },
        ],
        nextCursor: 5,
      });
    });

    it('imports a thread that predates the table once, from its checkpoint', async () => {
      chats.claimHistoryImport.mockResolvedValue(true);
      messages.listTurnsPage.mockResolvedValue({ rows: [], hasMore: false });
      const load = vi.fn(async () => [new HumanMessage('q'), new AIMessage('a')]);

      const page = await service().page({ ...chat, history_imported_at: null }, {}, load);

      expect(load).toHaveBeenCalledTimes(1);
      expect(messages.insertMany.mock.calls[0][0]).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('does not import again when another request already claimed it', async () => {
      messages.listTurnsPage.mockResolvedValue({ rows: [], hasMore: false });
      const load = vi.fn();

      await service().page({ ...chat, history_imported_at: null }, {}, load);

      expect(load).not.toHaveBeenCalled();
      expect(messages.insertMany).not.toHaveBeenCalled();
    });
  });
});

describe('ChatHistoryService.queueEmbeddings', () => {
  beforeEach(() => {
    dispatchEmbedding.mockReset().mockResolvedValue({ jobId: 'j' });
  });

  it('queues the given exchanges for embedding and reports how many', async () => {
    await expect(service().queueEmbeddings(['m1', 'm2'])).resolves.toBe(2);
    expect(dispatchEmbedding).toHaveBeenCalledWith(['m1', 'm2']);
  });

  it('queues nothing for an empty batch', async () => {
    await expect(service().queueEmbeddings([])).resolves.toBe(0);
    expect(dispatchEmbedding).not.toHaveBeenCalled();
  });

  it('lets a queue failure reach the sweep, which logs it per workspace', async () => {
    dispatchEmbedding.mockRejectedValue(new Error('no AWS'));
    await expect(service().queueEmbeddings(['m1'])).rejects.toThrow('no AWS');
  });
});
