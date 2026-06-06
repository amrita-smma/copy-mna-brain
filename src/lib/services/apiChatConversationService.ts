import type {
  ApiChatConversationRepository,
  ApiChatConversationRow,
} from '@/lib/repositories';

export class ApiChatConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`API chat conversation ${conversationId} not found`);
    this.name = 'ApiChatConversationNotFoundError';
  }
}

export class ApiChatConversationService {
  constructor(private readonly repo: ApiChatConversationRepository) {}

  list(apiKeyId: string) {
    return this.repo.listByApiKey(apiKeyId);
  }

  create(apiKeyId: string) {
    return this.repo.create(apiKeyId);
  }

  /**
   * Load a conversation and verify it belongs to the calling API key. Because
   * lookup is scoped by api_key_id, a conversation owned by a different key is
   * indistinguishable from a missing one — both raise NotFound, so a client can
   * never probe for or resume another client's conversation.
   */
  async assertOwnedBy(
    conversationId: string,
    apiKeyId: string,
  ): Promise<ApiChatConversationRow> {
    const row = await this.repo.getByIdForApiKey(conversationId, apiKeyId);
    if (!row) throw new ApiChatConversationNotFoundError(conversationId);
    return row;
  }

  touchLastActive(conversationId: string) {
    return this.repo.touchLastActive(conversationId);
  }

  setTitle(conversationId: string, title: string) {
    return this.repo.setTitle(conversationId, title);
  }
}
