import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApiChatConversationService,
  ApiChatConversationNotFoundError,
} from './apiChatConversationService';
import type { ApiChatConversationRepository } from '@/lib/repositories';

describe('ApiChatConversationService', () => {
  let repo: {
    listByApiKey: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    getByIdForApiKey: ReturnType<typeof vi.fn>;
    touchLastActive: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
  };
  let service: ApiChatConversationService;

  beforeEach(() => {
    repo = {
      listByApiKey: vi.fn(),
      create: vi.fn(),
      getByIdForApiKey: vi.fn(),
      touchLastActive: vi.fn(),
      setTitle: vi.fn(),
    };
    service = new ApiChatConversationService(
      repo as unknown as ApiChatConversationRepository,
    );
  });

  it('list delegates to repo.listByApiKey', async () => {
    repo.listByApiKey.mockResolvedValueOnce([{ id: 'c1' }]);
    const result = await service.list('k1');
    expect(result).toEqual([{ id: 'c1' }]);
    expect(repo.listByApiKey).toHaveBeenCalledWith('k1');
  });

  it('create delegates to repo.create', async () => {
    repo.create.mockResolvedValueOnce({ id: 'c1', api_key_id: 'k1' });
    const result = await service.create('k1');
    expect(result).toEqual({ id: 'c1', api_key_id: 'k1' });
    expect(repo.create).toHaveBeenCalledWith('k1');
  });

  describe('assertOwnedBy', () => {
    it('returns the conversation when ownership matches', async () => {
      const conv = { id: 'c1', api_key_id: 'k1' };
      repo.getByIdForApiKey.mockResolvedValueOnce(conv);

      const result = await service.assertOwnedBy('c1', 'k1');

      expect(result).toEqual(conv);
      expect(repo.getByIdForApiKey).toHaveBeenCalledWith('c1', 'k1');
    });

    it('throws NotFound when missing or owned by another key', async () => {
      repo.getByIdForApiKey.mockResolvedValueOnce(null);

      await expect(service.assertOwnedBy('c1', 'k1')).rejects.toBeInstanceOf(
        ApiChatConversationNotFoundError,
      );
    });
  });
});
