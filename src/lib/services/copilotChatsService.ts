import { createHash } from 'crypto';
import type { CopilotChatsRepository, CopilotChatRow } from '@/lib/repositories';
import type { EffortChoice } from '@/lib/agents/analysis';
import {
  resolveInsightAgentStamp,
  type InsightAgentStamp,
} from '@/lib/insights/agentStamp';
import { isUuid } from '@/lib/uuid';

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

  /**
   * Create a chat. `agentKey` pre-pins its agent — only a fork passes one, to
   * carry its source thread's agent; a new chat resolves on its first turn.
   */
  create(userId: string, agentKey?: string) {
    return this.repo.create(userId, agentKey);
  }

  /**
   * A chat in this workspace by id, with no owner check. Only for the chat
   * cache, which is workspace-global: fork reads the cached source thread,
   * which may belong to a colleague. Everything user-scoped goes through
   * `assertOwnedBy`.
   */
  findInWorkspace(chatId: string): Promise<CopilotChatRow | null> {
    return this.repo.getById(chatId);
  }

  /**
   * Pin the agent the thread runs on (MB-549). Written once: when the thread
   * is already pinned the stored agent wins and is returned, so a thread never
   * changes agent. Returns null only when the chat is not in this workspace.
   */
  pinAgent(chatId: string, agentKey: string): Promise<string | null> {
    return this.repo.pinAgentKey(chatId, agentKey);
  }

  /**
   * The version stamp for an insight version written from this chat, e.g. an
   * approved insight edit card (MB-541/549): the thread's pinned agent, or null
   * for the general CoPilot. The chat must belong to the user; an unknown or
   * foreign chat also yields null, so a bad id never blocks the publish — it
   * only leaves the version unstamped. A malformed id is rejected before the
   * query (the column is a uuid, and Postgres would throw).
   */
  async agentStampFor(
    chatId: string,
    userId: string,
  ): Promise<InsightAgentStamp | null> {
    if (!isUuid(chatId)) return null;
    const chat = await this.repo.getById(chatId);
    if (!chat || chat.user_id !== userId) return null;
    return resolveInsightAgentStamp(chat.agent_key);
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
   * Persist the effort tier this thread runs at. Idempotent by design: the
   * route writes the tier it resolved on every turn, so a thread that was
   * routed before an escalation ends up storing the escalated tier.
   */
  setEffortTier(chatId: string, tier: EffortChoice) {
    return this.repo.setEffortTier(chatId, tier);
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
   * message and runs on the same agent (`agentKey`, a registry key or
   * 'general') as the new chat would. Returns the matched chat row, or null
   * when there's no match or the message is empty.
   */
  async findCachedFirstTurn(
    rawMessage: string,
    agentKey: string,
  ): Promise<CopilotChatRow | null> {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;
    return this.repo.findLatestFirstMessageMatch(hashFirstMessage(rawMessage), agentKey);
  }
}
