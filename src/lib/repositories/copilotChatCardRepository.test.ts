import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copilotChatCards } from '@/lib/db/schema';
import { CopilotChatCardRepository } from './copilotChatCardRepository';

const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn(),
  returning: vi.fn(),
};
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
  limit: vi.fn(),
};

const mockDb = {
  insert: vi.fn().mockReturnValue(insertChain),
  select: vi.fn().mockReturnValue(selectChain),
};

describe('CopilotChatCardRepository', () => {
  let repo: CopilotChatCardRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.insert.mockReturnValue(insertChain);
    mockDb.select.mockReturnValue(selectChain);
    insertChain.values.mockReturnThis();
    selectChain.from.mockReturnThis();
    selectChain.where.mockReturnThis();
    repo = new CopilotChatCardRepository(mockDb as never, 'workspace-1');
  });

  describe('CopilotChatCardRepository.registerMany', () => {
    it('returns without hitting the DB when there are no cards', async () => {
      await repo.registerMany([]);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('inserts every card scoped to the workspace, and on conflict fills in only the reply facts', async () => {
      insertChain.onConflictDoUpdate.mockResolvedValueOnce(undefined);

      await repo.registerMany([
        { chatId: 'chat-1', messageId: 'm-1', cardId: 'ap-1', toolName: 'offer_options', summary: 'Options: x' },
      ]);

      expect(mockDb.insert).toHaveBeenCalledWith(copilotChatCards);
      expect(insertChain.values).toHaveBeenCalledWith([
        {
          workspace_id: 'workspace-1',
          chat_id: 'chat-1',
          message_id: 'm-1',
          card_id: 'ap-1',
          tool_name: 'offer_options',
          summary: 'Options: x',
        },
      ]);
      const conflict = insertChain.onConflictDoUpdate.mock.calls[0][0];
      expect(conflict.target).toEqual([copilotChatCards.chat_id, copilotChatCards.card_id]);
      // The decision is never overwritten by a late registration.
      expect(Object.keys(conflict.set).sort()).toEqual(['message_id', 'summary', 'updated_at']);
    });
  });

  describe('CopilotChatCardRepository.decide', () => {
    const decision = {
      chatId: 'chat-1',
      cardId: 'ap-1',
      toolName: 'propose_bulk_drop_companies',
      status: 'accepted' as const,
      resolutionText: 'Dropped 2.',
      decisionData: { company_ids: ['c1'] },
      decidedByUserId: 'user-1',
    };

    beforeEach(() => {
      insertChain.onConflictDoUpdate.mockReturnValue(insertChain);
    });

    it('writes the decision, updating only a pending row', async () => {
      insertChain.returning.mockResolvedValueOnce([{ id: 'row-1', status: 'accepted' }]);

      const row = await repo.decide(decision);

      expect(row).toEqual({ id: 'row-1', status: 'accepted' });
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: 'workspace-1',
          chat_id: 'chat-1',
          card_id: 'ap-1',
          tool_name: 'propose_bulk_drop_companies',
          status: 'accepted',
          resolution_text: 'Dropped 2.',
          decision_data: { company_ids: ['c1'] },
          decided_by_user_id: 'user-1',
        }),
      );
      const conflict = insertChain.onConflictDoUpdate.mock.calls[0][0];
      expect(conflict.setWhere).toBeDefined();
      expect(conflict.set).toMatchObject({ status: 'accepted', resolution_text: 'Dropped 2.' });
    });

    it('returns null when the card was already decided', async () => {
      insertChain.returning.mockResolvedValueOnce([]);
      expect(await repo.decide(decision)).toBeNull();
    });
  });

  describe('CopilotChatCardRepository.findByCardIds', () => {
    it('returns [] without hitting the DB when the id list is empty', async () => {
      expect(await repo.findByCardIds('chat-1', [])).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('reads the cards in one query, ordered by card id', async () => {
      selectChain.orderBy.mockResolvedValueOnce([{ card_id: 'a' }, { card_id: 'b' }]);
      expect(await repo.findByCardIds('chat-1', ['b', 'a'])).toEqual([{ card_id: 'a' }, { card_id: 'b' }]);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('CopilotChatCardRepository.findByCardId', () => {
    it('returns the row, or null when there is none', async () => {
      selectChain.limit.mockResolvedValueOnce([{ card_id: 'a' }]).mockResolvedValueOnce([]);
      expect(await repo.findByCardId('chat-1', 'a')).toEqual({ card_id: 'a' });
      expect(await repo.findByCardId('chat-1', 'b')).toBeNull();
    });
  });

  describe('CopilotChatCardRepository.listRecent', () => {
    it('reads at most `limit` cards a stored reply offered, newest first', async () => {
      selectChain.orderBy.mockReturnValueOnce(selectChain);
      selectChain.limit.mockResolvedValueOnce([{ card_id: 'new' }]);
      expect(await repo.listRecent('chat-1', 10)).toEqual([{ card_id: 'new' }]);
      expect(selectChain.limit).toHaveBeenCalledWith(10);
    });
  });
});
