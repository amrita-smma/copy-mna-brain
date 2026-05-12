import type { CopilotChatsRepository, CopilotChatRow } from '@/lib/repositories';

export class CopilotChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Copilot chat ${chatId} not found`);
    this.name = 'CopilotChatNotFoundError';
  }
}

export class CopilotChatForbiddenError extends Error {
  constructor(chatId: string) {
    super(`Copilot chat ${chatId} is not owned by the requesting user`);
    this.name = 'CopilotChatForbiddenError';
  }
}

export class CopilotChatsService {
  constructor(private readonly repo: CopilotChatsRepository) {}

  list(userId: string) {
    return this.repo.listByUser(userId);
  }

  create(userId: string) {
    return this.repo.create(userId);
  }

  /**
   * Loads a chat and verifies it belongs to the requesting user. Throws on
   * mismatch — every chat-scoped API entrypoint must call this before reading
   * or mutating thread state.
   */
  async assertOwnedBy(chatId: string, userId: string): Promise<CopilotChatRow> {
    const chat = await this.repo.getById(chatId);
    if (!chat) throw new CopilotChatNotFoundError(chatId);
    if (chat.user_id !== userId) throw new CopilotChatForbiddenError(chatId);
    return chat;
  }

  touchLastActive(chatId: string) {
    return this.repo.touchLastActive(chatId);
  }

  setTitle(chatId: string, title: string) {
    return this.repo.setTitle(chatId, title);
  }
}
