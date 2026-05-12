import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CopilotChatsService,
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from './copilotChatsService';
import type { CopilotChatsRepository } from '@/lib/repositories';

describe('CopilotChatsService', () => {
  let repo: {
    listByUser: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    touchLastActive: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
  };
  let service: CopilotChatsService;

  beforeEach(() => {
    repo = {
      listByUser: vi.fn(),
      create: vi.fn(),
      getById: vi.fn(),
      touchLastActive: vi.fn(),
      setTitle: vi.fn(),
    };
    service = new CopilotChatsService(repo as unknown as CopilotChatsRepository);
  });

  it('list delegates to repo.listByUser', async () => {
    repo.listByUser.mockResolvedValueOnce([{ id: 'c1' }]);
    const result = await service.list('u1');
    expect(result).toEqual([{ id: 'c1' }]);
    expect(repo.listByUser).toHaveBeenCalledWith('u1');
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
});
