import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ChatHistoryService } from './chatHistoryService';
import { FROM_BOT_KWARG, FROM_ROUTINE_KWARG } from '@/lib/chat/uiMessages';
import { OPTION_CARD_MARKER } from '@/lib/chat/optionCards';
import { encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import { TOOL_OUTPUT_CLIENT_CHARS } from '@/lib/chat/toolOutputClip';

const messages = vi.hoisted(() => ({
  insertMany: vi.fn(),
  listPage: vi.fn(),
  listTurnsPage: vi.fn(),
  deleteById: vi.fn(),
  findByToolCallId: vi.fn(),
}));
const chats = vi.hoisted(() => ({
  claimHistoryImport: vi.fn(),
  stampMessage: vi.fn(),
  getById: vi.fn(),
  clearHistoryImport: vi.fn(),
}));
const dispatchEmbedding = vi.hoisted(() => vi.fn());
const feedback = vi.hoisted(() => ({ findByMessageIds: vi.fn() }));
const cards = vi.hoisted(() => ({ registerMany: vi.fn(), findByCardIds: vi.fn() }));

/** A stored offer_options tool part whose card has the given id. */
function optionCardPart(cardId: string) {
  const payload = { card_id: cardId, question: 'Which?', mode: 'single', options: [], allow_custom: false };
  return {
    type: 'dynamic-tool',
    toolCallId: `call-${cardId}`,
    toolName: 'offer_options',
    state: 'output-available',
    input: {},
    output: { kwargs: { content: `Options offered.\n${encodeApprovalMarker(OPTION_CARD_MARKER, payload)}` } },
  };
}

const chat = { id: 'chat-1', user_id: 'u1', bot_id: 'bot-1', history_imported_at: '2026-10-14T00:00:00Z' };

function service() {
  return new ChatHistoryService({
    messages: messages as never,
    chats: chats as never,
    feedback: feedback as never,
    cards: cards as never,
    dispatchEmbedding,
  });
}

describe('ChatHistoryService', () => {
  beforeEach(() => {
    for (const fn of [
      ...Object.values(messages),
      ...Object.values(chats),
      ...Object.values(feedback),
      ...Object.values(cards),
      dispatchEmbedding,
    ]) {
      fn.mockReset();
    }
    feedback.findByMessageIds.mockResolvedValue([]);
    cards.registerMany.mockResolvedValue(undefined);
    cards.findByCardIds.mockResolvedValue([]);
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

    it('registers the action cards the stored reply offered, against its row', async () => {
      const withCard = [
        new HumanMessage({ id: 'h1', content: 'Pick one' }),
        new AIMessage({
          id: 'a1',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'offer_options', args: {} }],
        }),
        new ToolMessage({
          content: optionCardPart('card-1').output.kwargs.content,
          tool_call_id: 'call-1',
          name: 'offer_options',
        }),
        new AIMessage({ id: 'a2', content: 'Pick from the card.' }),
      ];

      await service().persistTurn({ chat, finalMessages: withCard, interactive: true });

      expect(cards.registerMany).toHaveBeenCalledWith([
        { chatId: 'chat-1', messageId: 'm1', cardId: 'card-1', toolName: 'offer_options', summary: 'Options: Which?' },
      ]);
    });

    it('still stores the turn when registering its cards fails', async () => {
      cards.registerMany.mockRejectedValue(new Error('db down'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await service().persistTurn({ chat, finalMessages, interactive: true });

      expect(dispatchEmbedding).toHaveBeenCalledWith(['m1']);
      expect(chats.stampMessage).toHaveBeenCalled();
      spy.mockRestore();
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

    it('stores the question under the id and turn facts it was handed when the up-front write failed', async () => {
      await service().persistTurn({
        chat,
        finalMessages,
        interactive: true,
        questionStored: false,
        question: { id: 'q-chosen', turn: { model: 'claude-sonnet-5-5', effortTier: 'medium' } },
      });

      const rows = messages.insertMany.mock.calls[0][0];
      expect(rows).toEqual([
        expect.objectContaining({
          role: 'user',
          id: 'q-chosen',
          model: 'claude-sonnet-5-5',
          effort_tier: 'medium',
          text: 'How many deals?',
        }),
        expect.objectContaining({ role: 'assistant' }),
      ]);
      expect(rows[1]).not.toHaveProperty('id');
    });

    it('stores no question row when its up-front write landed, whatever id it was handed', async () => {
      await service().persistTurn({ chat, finalMessages, interactive: true, questionStored: true, question: { id: 'q-chosen' } });

      expect(messages.insertMany.mock.calls[0][0]).toEqual([expect.objectContaining({ role: 'assistant' })]);
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

    it('stamps the model and effort tier the turn runs on onto the question row', async () => {
      await service().persistQuestion({
        chat,
        message: new HumanMessage('Find targets'),
        prior: [],
        turn: { model: 'claude-sonnet-5-5', effortTier: 'medium' },
      });

      expect(messages.insertMany.mock.calls[0][0]).toEqual([
        expect.objectContaining({ role: 'user', model: 'claude-sonnet-5-5', effort_tier: 'medium' }),
      ]);
    });

    it('leaves the turn facts off when the caller has none (a background bot turn)', async () => {
      await service().persistQuestion({ chat, message: new HumanMessage('Find targets'), prior: [] });

      expect(messages.insertMany.mock.calls[0][0][0]).not.toHaveProperty('model');
    });
  });

  describe('ChatHistoryService.persistQuestion with a chosen id', () => {
    it('stores the row under the id the caller picked, with the turn facts', async () => {
      await service().persistQuestion({
        chat,
        message: new HumanMessage('Find targets'),
        prior: [],
        turn: { model: 'claude-sonnet-5-5', effortTier: 'low' },
        id: 'q-chosen',
      });

      expect(messages.insertMany.mock.calls[0][0]).toEqual([
        expect.objectContaining({ role: 'user', id: 'q-chosen', model: 'claude-sonnet-5-5', effort_tier: 'low' }),
      ]);
    });

    it('leaves the id to the database when the caller picked none', async () => {
      await service().persistQuestion({ chat, message: new HumanMessage('Find targets'), prior: [] });

      expect(messages.insertMany.mock.calls[0][0][0]).not.toHaveProperty('id');
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
          {
            id: 'r6',
            role: 'assistant',
            parts: [{ type: 'text', text: 'a' }],
            metadata: { createdAt: '2026-10-14T09:06:00.000Z', questionId: 'r5' },
          },
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

    it("keys each reply on its turn's question and lays the user's feedback on it, in one query", async () => {
      messages.listTurnsPage.mockResolvedValue({
        rows: [
          row(1, 'assistant', [{ type: 'text', text: 'greeting before any question' }]),
          row(2, 'user', [{ type: 'text', text: 'q1' }]),
          row(3, 'assistant', [{ type: 'text', text: 'a1' }]),
          row(4, 'user', [{ type: 'text', text: 'q2' }]),
          row(5, 'assistant', [{ type: 'text', text: 'a2' }]),
        ],
        hasMore: false,
      });
      feedback.findByMessageIds.mockResolvedValue([
        { message_id: 'r4', rating: -1, reasons: ['shallow', 'retired_reason'], comment: 'too thin' },
      ]);

      const page = await service().page(chat, {}, vi.fn());

      expect(feedback.findByMessageIds).toHaveBeenCalledTimes(1);
      expect(feedback.findByMessageIds).toHaveBeenCalledWith('u1', ['r2', 'r4']);
      const meta = page.messages.map((m) => m.metadata);
      expect(meta[0]).not.toHaveProperty('questionId');
      expect(meta[1]).not.toHaveProperty('questionId');
      expect(meta[2]).toMatchObject({ questionId: 'r2' });
      expect(meta[2]).not.toHaveProperty('feedback');
      expect(meta[4]).toMatchObject({
        questionId: 'r4',
        feedback: { rating: -1, reasons: ['shallow'], comment: 'too thin' },
      });
    });

    it("lays the user's card decisions onto the replies that offered them, in one query", async () => {
      messages.listTurnsPage.mockResolvedValue({
        rows: [
          row(1, 'user', [{ type: 'text', text: 'q1' }]),
          row(2, 'assistant', [optionCardPart('card-a')]),
          row(3, 'user', [{ type: 'text', text: 'q2' }]),
          row(4, 'assistant', [optionCardPart('card-b')]),
        ],
        hasMore: false,
      });
      cards.findByCardIds.mockResolvedValue([
        {
          card_id: 'card-a',
          status: 'accepted',
          resolution_text: 'Option A',
          decision_data: { picked: ['Option A'] },
          decided_at: '2026-10-14T10:00:00Z',
        },
        { card_id: 'card-b', status: 'pending', resolution_text: null, decision_data: null, decided_at: null },
      ]);

      const page = await service().page(chat, {}, vi.fn());

      expect(cards.findByCardIds).toHaveBeenCalledTimes(1);
      expect(cards.findByCardIds).toHaveBeenCalledWith('chat-1', ['card-a', 'card-b']);
      expect(page.messages[1].metadata?.cardDecisions).toEqual({
        'card-a': {
          status: 'accepted',
          resolutionText: 'Option A',
          data: { picked: ['Option A'] },
          decidedAt: '2026-10-14T10:00:00Z',
        },
      });
      // A pending card carries no decision.
      expect(page.messages[3].metadata).not.toHaveProperty('cardDecisions');
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
  describe('ChatHistoryService.page — tool outputs', () => {
    const long = 'z'.repeat(TOOL_OUTPUT_CLIENT_CHARS + 50);
    const marker = encodeApprovalMarker('INSIGHT_EDIT_APPROVAL_JSON', { insight_id: 'i1' });
    const toolPart = {
      type: 'dynamic-tool',
      toolCallId: 'toolu_1',
      toolName: 'get_insight',
      state: 'output-available',
      input: { id: 'i1' },
      output: { kwargs: { content: `${long}\n${marker}` } },
    };
    const row = {
      id: 'a1',
      seq: 2,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Here.' }, toolPart],
      created_at: '2026-10-14T00:00:01Z',
    };

    it('sends each tool output head-first, its markers whole, and keeps the row untouched', async () => {
      messages.listTurnsPage.mockResolvedValue({ rows: [row], hasMore: false });

      const page = await service().page(chat, {}, async () => []);

      const [, part] = page.messages[0].parts as Array<{ output?: { kwargs: { content: string }; clipped?: unknown } }>;
      expect(part.output?.kwargs.content).toBe(`${'z'.repeat(TOOL_OUTPUT_CLIENT_CHARS)}\n${marker}`);
      expect(part.output?.clipped).toEqual({ fullChars: long.length + 1, toolCallId: 'toolu_1' });
      expect(toolPart.output.kwargs.content).toBe(`${long}\n${marker}`);
    });

    it('toolOutput returns the whole stored output of one call, or null when no reply holds it', async () => {
      messages.findByToolCallId.mockResolvedValueOnce(row);
      await expect(service().toolOutput('chat-1', 'toolu_1')).resolves.toBe(`${long}\n${marker}`);
      expect(messages.findByToolCallId).toHaveBeenCalledWith('chat-1', 'toolu_1');

      messages.findByToolCallId.mockResolvedValueOnce(null);
      await expect(service().toolOutput('chat-1', 'toolu_2')).resolves.toBeNull();
    });
  });
});
