import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CopilotChatsService,
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from './copilotChatsService';
import type { CopilotChatsRepository } from '@/lib/repositories';

describe('CopilotChatsService', () => {
  let repo: {
    getById: ReturnType<typeof vi.fn>;
    touchLastActive: ReturnType<typeof vi.fn>;
    pinAgentKey: ReturnType<typeof vi.fn>;
    isTurnRunning: ReturnType<typeof vi.fn>;
  };
  let signalStop: ReturnType<typeof vi.fn<(chatId: string) => Promise<void>>>;
  let service: CopilotChatsService;

  beforeEach(() => {
    repo = {
      getById: vi.fn(),
      touchLastActive: vi.fn(),
      pinAgentKey: vi.fn(),
      isTurnRunning: vi.fn(),
    };
    signalStop = vi.fn<(chatId: string) => Promise<void>>(async () => undefined);
    service = new CopilotChatsService(repo as unknown as CopilotChatsRepository, signalStop);
  });

  describe('CopilotChatsService.requestStop', () => {
    it('raises the Stop flag only while a turn is running', async () => {
      repo.isTurnRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.requestStop('c1')).resolves.toBe(true);
      expect(signalStop).toHaveBeenCalledWith('c1');

      await expect(service.requestStop('c1')).resolves.toBe(false);
      expect(signalStop).toHaveBeenCalledTimes(1);
    });
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

  it('pinAgent returns the key the repository reports, which is the earlier pin when a second pin loses', async () => {
    repo.pinAgentKey.mockResolvedValueOnce('general');

    await expect(service.pinAgent('c1', 'bangun')).resolves.toBe('general');
    expect(repo.pinAgentKey).toHaveBeenCalledWith('c1', 'bangun');
  });

  describe('CopilotChatsService.agentStampFor', () => {
    const CHAT_UUID = '11111111-2222-4333-8444-555555555555';

    it("stamps the thread's pinned sector agent", async () => {
      repo.getById.mockResolvedValueOnce({ id: 'c1', user_id: 'u1', agent_key: 'bangun' });

      const stamp = await service.agentStampFor(CHAT_UUID, 'u1');

      expect(stamp).toEqual({ agentKey: 'bangun' });
    });

    it.each([
      ['a general-CoPilot thread', { id: 'c1', user_id: 'u1', agent_key: 'general' }],
      ["another user's chat, instead of throwing", { id: 'c1', user_id: 'u2', agent_key: 'bangun' }],
      ['a chat not in this workspace', null],
    ])('returns null for %s', async (_label, row) => {
      repo.getById.mockResolvedValueOnce(row);

      await expect(service.agentStampFor(CHAT_UUID, 'u1')).resolves.toBeNull();
    });

    it('returns null for a malformed chat id without querying', async () => {
      await expect(service.agentStampFor('not-a-uuid', 'u1')).resolves.toBeNull();
      expect(repo.getById).not.toHaveBeenCalled();
    });
  });
});
