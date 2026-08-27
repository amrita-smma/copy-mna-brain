import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CopilotChatsService,
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
  hashFirstMessage,
  isCacheableResponse,
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_HISTORY_MAX_PAGE_SIZE,
} from './copilotChatsService';
import type { CopilotChatsRepository } from '@/lib/repositories';

describe('CopilotChatsService', () => {
  let repo: {
    listByUser: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    touchLastActive: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
    recordFirstMessage: ReturnType<typeof vi.fn>;
    findLatestFirstMessageMatch: ReturnType<typeof vi.fn>;
  };
  let service: CopilotChatsService;

  beforeEach(() => {
    repo = {
      listByUser: vi.fn(),
      create: vi.fn(),
      getById: vi.fn(),
      touchLastActive: vi.fn(),
      setTitle: vi.fn(),
      recordFirstMessage: vi.fn(),
      findLatestFirstMessageMatch: vi.fn(),
    };
    service = new CopilotChatsService(repo as unknown as CopilotChatsRepository);
  });

  it('list returns the first page and reports no more when the page is short', async () => {
    repo.listByUser.mockResolvedValueOnce([{ id: 'c1' }]);

    const result = await service.list('u1');

    expect(result).toEqual({ chats: [{ id: 'c1' }], hasMore: false, nextOffset: null });
    // limit + 1: the extra row is what tells us whether another page exists,
    // without a second COUNT over a table that grows without bound.
    expect(repo.listByUser).toHaveBeenCalledWith('u1', {
      limit: CHAT_HISTORY_PAGE_SIZE + 1,
      offset: 0,
    });
  });

  it('trims the probe row and reports hasMore when a full page came back', async () => {
    const rows = Array.from({ length: CHAT_HISTORY_PAGE_SIZE + 1 }, (_, i) => ({
      id: `c${i}`,
    }));
    repo.listByUser.mockResolvedValueOnce(rows);

    const result = await service.list('u1');

    expect(result.chats).toHaveLength(CHAT_HISTORY_PAGE_SIZE);
    expect(result.chats.at(-1)).toEqual({ id: `c${CHAT_HISTORY_PAGE_SIZE - 1}` });
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(CHAT_HISTORY_PAGE_SIZE);
  });

  it('advances nextOffset past the rows already served', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}` }));
    repo.listByUser.mockResolvedValueOnce(rows);

    const result = await service.list('u1', { limit: 3, offset: 30 });

    expect(repo.listByUser).toHaveBeenCalledWith('u1', { limit: 4, offset: 30 });
    expect(result.nextOffset).toBe(33);
  });

  it('clamps a hostile page size instead of letting one request drain the table', async () => {
    repo.listByUser.mockResolvedValue([]);

    await service.list('u1', { limit: 100_000 });
    expect(repo.listByUser).toHaveBeenCalledWith('u1', {
      limit: CHAT_HISTORY_MAX_PAGE_SIZE + 1,
      offset: 0,
    });

    await service.list('u1', { limit: 0, offset: -5 });
    expect(repo.listByUser).toHaveBeenLastCalledWith('u1', { limit: 2, offset: 0 });
  });

  it('create delegates to repo.create', async () => {
    repo.create.mockResolvedValueOnce({ id: 'c1', user_id: 'u1' });
    const result = await service.create('u1');
    expect(result).toEqual({ id: 'c1', user_id: 'u1' });
    expect(repo.create).toHaveBeenCalledWith('u1');
  });

  describe('assertOwnedBy', () => {
    it('returns the chat when ownership matches', async () => {
      const chat = { id: 'c1', user_id: 'u1' };
      repo.getById.mockResolvedValueOnce(chat);

      const result = await service.assertOwnedBy('c1', 'u1');

      expect(result).toEqual(chat);
    });

    it('throws CopilotChatNotFoundError when chat is missing', async () => {
      repo.getById.mockResolvedValueOnce(null);

      await expect(service.assertOwnedBy('missing', 'u1')).rejects.toBeInstanceOf(
        CopilotChatNotFoundError,
      );
    });

    it('throws CopilotChatForbiddenError when chat belongs to another user', async () => {
      repo.getById.mockResolvedValueOnce({ id: 'c1', user_id: 'someone-else' });

      await expect(service.assertOwnedBy('c1', 'u1')).rejects.toBeInstanceOf(
        CopilotChatForbiddenError,
      );
    });
  });

  describe('hashFirstMessage', () => {
    it('treats trim/case/whitespace differences as equal', () => {
      expect(hashFirstMessage('Hello   World ')).toBe(hashFirstMessage('hello world'));
    });

    it('produces different hashes for different questions', () => {
      expect(hashFirstMessage('What is our thesis?')).not.toBe(
        hashFirstMessage('What is the pipeline?'),
      );
    });
  });

  describe('isCacheableResponse', () => {
    it('rejects responses with 6 or fewer words', () => {
      expect(isCacheableResponse('one two three four five six')).toBe(false);
      expect(isCacheableResponse('short answer')).toBe(false);
      expect(isCacheableResponse('   ')).toBe(false);
    });

    it('accepts responses with more than 6 words', () => {
      expect(isCacheableResponse('one two three four five six seven')).toBe(true);
    });

    it('ignores extra whitespace when counting words', () => {
      expect(isCacheableResponse('  a  b   c d e f ')).toBe(false);
      expect(isCacheableResponse('a b c d e f g h')).toBe(true);
    });
  });

  describe('recordFirstMessage', () => {
    it('stores the raw message with its normalized hash', async () => {
      await service.recordFirstMessage('c1', 'Hello World');

      expect(repo.recordFirstMessage).toHaveBeenCalledWith(
        'c1',
        'Hello World',
        hashFirstMessage('Hello World'),
      );
    });

    it('no-ops on a blank message', async () => {
      await service.recordFirstMessage('c1', '   ');

      expect(repo.recordFirstMessage).not.toHaveBeenCalled();
    });
  });

  describe('findCachedFirstTurn', () => {
    it('looks up by the normalized hash and returns the match', async () => {
      const row = { id: 'c9' };
      repo.findLatestFirstMessageMatch.mockResolvedValueOnce(row);

      const result = await service.findCachedFirstTurn(' Hello World ');

      expect(repo.findLatestFirstMessageMatch).toHaveBeenCalledWith(
        hashFirstMessage('hello world'),
      );
      expect(result).toEqual(row);
    });

    it('returns null without hitting the repo for a blank message', async () => {
      const result = await service.findCachedFirstTurn('  ');

      expect(result).toBeNull();
      expect(repo.findLatestFirstMessageMatch).not.toHaveBeenCalled();
    });
  });
});
