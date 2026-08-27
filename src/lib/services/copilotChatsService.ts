import { createHash } from 'crypto';
import type { CopilotChatsRepository, CopilotChatRow } from '@/lib/repositories';

/**
 * Normalize a first user message so trivial differences (surrounding/whitespace
 * and case) still produce a cache hit, then hash it. The hash is what gets
 * stored and compared — never the normalized text itself.
 */
export function hashFirstMessage(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Minimum word count for a cached assistant response to be worth surfacing.
 * Trivially short answers aren't useful to reuse, so we only cache responses
 * with MORE than this many words.
 */
export const MIN_CACHED_RESPONSE_WORDS = 6;

/** True when an assistant response is substantial enough to offer as a cache hit. */
export function isCacheableResponse(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words > MIN_CACHED_RESPONSE_WORDS;
}

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

/** Chats returned per page when the caller doesn't ask for a specific size. */
export const CHAT_HISTORY_PAGE_SIZE = 20;

/** Upper bound on a caller-supplied page size, so one request can't ask for everything. */
export const CHAT_HISTORY_MAX_PAGE_SIZE = 100;

export interface ChatHistoryPage {
  chats: CopilotChatRow[];
  /** Whether another page exists after this one. */
  hasMore: boolean;
  /** Offset to pass for the next page; null when this is the last page. */
  nextOffset: number | null;
}

export class CopilotChatsService {
  constructor(private readonly repo: CopilotChatsRepository) {}

  /**
   * One page of the user's chat history, newest activity first.
   *
   * Reads `limit + 1` rows and discards the extra: that tells us whether a
   * further page exists without paying for a second COUNT query over a table
   * that grows without bound. The sidebar uses `hasMore` to decide whether to
   * keep observing its scroll sentinel.
   */
  async list(
    userId: string,
    { limit, offset = 0 }: { limit?: number; offset?: number } = {},
  ): Promise<ChatHistoryPage> {
    const pageSize = Math.min(
      Math.max(Math.trunc(limit ?? CHAT_HISTORY_PAGE_SIZE), 1),
      CHAT_HISTORY_MAX_PAGE_SIZE,
    );
    const start = Math.max(Math.trunc(offset), 0);
    const rows = await this.repo.listByUser(userId, {
      limit: pageSize + 1,
      offset: start,
    });
    const hasMore = rows.length > pageSize;
    const chats = hasMore ? rows.slice(0, pageSize) : rows;
    return {
      chats,
      hasMore,
      nextOffset: hasMore ? start + chats.length : null,
    };
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

  /**
   * Record the first user message of a chat for the cache. No-ops on an empty
   * message so we never index a blank key.
   */
  async recordFirstMessage(chatId: string, rawMessage: string): Promise<void> {
    const trimmed = rawMessage.trim();
    if (!trimmed) return;
    await this.repo.recordFirstMessage(
      chatId,
      rawMessage,
      hashFirstMessage(rawMessage),
    );
  }

  /**
   * Look up a prior chat that started with the same (normalized) first user
   * message. Returns the matched chat row, or null when there's no match or
   * the message is empty.
   */
  async findCachedFirstTurn(rawMessage: string): Promise<CopilotChatRow | null> {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;
    return this.repo.findLatestFirstMessageMatch(hashFirstMessage(rawMessage));
  }
}
