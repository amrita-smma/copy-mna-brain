import { requestStopSignal } from '@/lib/bots/presence';
import type { CopilotChatsRepository, CopilotChatRow } from '@/lib/repositories';
import {
  resolveInsightAgentStamp,
  type InsightAgentStamp,
} from '@/lib/insights/agentStamp';
import { isUuid } from '@/lib/uuid';

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
  constructor(
    private readonly repo: CopilotChatsRepository,
    /** Sets the Stop flag the running turn polls; injectable for tests. */
    private readonly signalStop: (chatId: string) => Promise<void> = requestStopSignal,
  ) {}

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

  /**
   * Take the thread's turn lock (see `CopilotChatsRepository.claimTurn`).
   * False while another turn — a bot answering a message from another bot —
   * is writing the thread.
   */
  claimTurn(chatId: string, ttlSeconds: number): Promise<boolean> {
    return this.repo.claimTurn(chatId, ttlSeconds);
  }

  releaseTurn(chatId: string): Promise<void> {
    return this.repo.releaseTurn(chatId);
  }

  /**
   * The user pressed Stop. A chat turn outlives its browser connection, so
   * this is how Stop reaches it: a flag in Redis (`@/lib/bots/presence`) the
   * running turn polls. False when no turn is running, so a stale Stop never
   * waits for the next one.
   */
  async requestStop(chatId: string): Promise<boolean> {
    if (!(await this.repo.isTurnRunning(chatId))) return false;
    await this.signalStop(chatId);
    return true;
  }

  /** The user has seen the thread's latest reply. */
  markUnread(chatId: string): Promise<void> {
    return this.repo.markUnread(chatId);
  }

  markRead(chatId: string): Promise<void> {
    return this.repo.markRead(chatId);
  }
}
