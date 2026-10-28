import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CardDecisionConflictError,
  CopilotChatCardService,
  InvalidCardDecisionError,
  MAX_DECISION_DATA_CHARS,
  toActionCardDecision,
} from './copilotChatCardService';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from './copilotChatsService';

const cards = vi.hoisted(() => ({ decide: vi.fn(), findByCardId: vi.fn(), listRecent: vi.fn() }));
const chats = vi.hoisted(() => ({ getById: vi.fn() }));

const decidedRow = {
  card_id: 'ap-1',
  tool_name: 'propose_bulk_drop_companies',
  summary: 'Drop 2 companies: Stale',
  status: 'accepted' as const,
  resolution_text: 'Dropped 2.',
  decision_data: { company_ids: ['c1'] },
  decided_at: '2026-10-28T09:00:00Z',
};

function service() {
  return new CopilotChatCardService({ cards: cards as never, chats: chats as never });
}

const input = {
  userId: 'user-1',
  chatId: 'chat-1',
  cardId: 'ap-1',
  toolName: 'propose_bulk_drop_companies',
  status: 'accepted',
  resolutionText: '  Dropped 2.  ',
  data: { company_ids: ['c1'] },
};

describe('CopilotChatCardService.decide', () => {
  beforeEach(() => {
    for (const fn of [...Object.values(cards), ...Object.values(chats)]) fn.mockReset();
    chats.getById.mockResolvedValue({ id: 'chat-1', user_id: 'user-1' });
    cards.decide.mockResolvedValue(decidedRow);
  });

  it("records the decision on the caller's own chat", async () => {
    const result = await service().decide(input);

    expect(cards.decide).toHaveBeenCalledWith({
      chatId: 'chat-1',
      cardId: 'ap-1',
      toolName: 'propose_bulk_drop_companies',
      status: 'accepted',
      resolutionText: 'Dropped 2.',
      decisionData: { company_ids: ['c1'] },
      decidedByUserId: 'user-1',
    });
    expect(result).toEqual({
      alreadyDecided: false,
      decision: {
        status: 'accepted',
        resolutionText: 'Dropped 2.',
        data: { company_ids: ['c1'] },
        decidedAt: '2026-10-28T09:00:00Z',
      },
    });
  });

  it('returns the decision that stands when the card was decided first elsewhere', async () => {
    cards.decide.mockResolvedValue(null);
    cards.findByCardId.mockResolvedValue({ ...decidedRow, status: 'declined', resolution_text: 'Kept all.' });

    const result = await service().decide(input);

    expect(result.alreadyDecided).toBe(true);
    expect(result.decision).toMatchObject({ status: 'declined', resolutionText: 'Kept all.' });
  });

  it('raises a conflict when the write is refused and no decision stands', async () => {
    cards.decide.mockResolvedValue(null);
    cards.findByCardId.mockResolvedValue({ ...decidedRow, status: 'pending' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(service().decide(input)).rejects.toBeInstanceOf(CardDecisionConflictError);
    spy.mockRestore();
  });

  it('rejects a bad status, an unknown tool, a non-object or oversized detail, and a blank card id', async () => {
    const bad = [
      { status: 'pending' },
      { toolName: 'web_search' },
      { toolName: undefined },
      { data: ['x'] },
      { data: { blob: 'x'.repeat(MAX_DECISION_DATA_CHARS) } },
      { resolutionText: 42 },
      { cardId: '  ' },
    ];
    for (const over of bad) {
      await expect(service().decide({ ...input, ...over })).rejects.toBeInstanceOf(InvalidCardDecisionError);
    }
    expect(cards.decide).not.toHaveBeenCalled();
  });

  it("refuses another user's chat and a missing chat", async () => {
    chats.getById.mockResolvedValueOnce({ id: 'chat-1', user_id: 'someone-else' });
    await expect(service().decide(input)).rejects.toBeInstanceOf(CopilotChatForbiddenError);
    chats.getById.mockResolvedValueOnce(null);
    await expect(service().decide(input)).rejects.toBeInstanceOf(CopilotChatNotFoundError);
    expect(cards.decide).not.toHaveBeenCalled();
  });
});

describe('CopilotChatCardService.promptContext', () => {
  beforeEach(() => cards.listRecent.mockReset());

  it("describes the chat's recent cards, or null when it has none", async () => {
    cards.listRecent.mockResolvedValueOnce([decidedRow]).mockResolvedValueOnce([]);

    const text = await service().promptContext('chat-1');
    expect(cards.listRecent).toHaveBeenCalledWith('chat-1', 10);
    expect(text).toContain('Accepted by the user');
    expect(await service().promptContext('chat-1')).toBeNull();
  });
});

describe('toActionCardDecision', () => {
  it('is null for a pending card', () => {
    expect(toActionCardDecision({ ...decidedRow, status: 'pending' } as never)).toBeNull();
  });
});
