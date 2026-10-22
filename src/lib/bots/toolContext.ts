import type { RunnableConfig } from '@langchain/core/runnables';
import type { BotDto } from './types';

/**
 * Who a bot tool acts for: the signed-in user chatting, and the bot whose
 * turn it is. Both come from the turn's `configurable` (set by `/api/chat`
 * and the background bot turn), never from a tool argument the model could
 * choose — a bot's tools always run with the chatting user's permissions.
 */
export interface BotToolContext {
  userId: string;
  botId: string | null;
}

export function readBotToolContext(config: RunnableConfig | undefined): BotToolContext | null {
  const configurable = config?.configurable as Record<string, unknown> | undefined;
  const userId = configurable?.userId;
  if (typeof userId !== 'string' || !userId) return null;
  const botId = configurable?.botId;
  return { userId, botId: typeof botId === 'string' && botId ? botId : null };
}

export const NO_USER_CONTEXT_ERROR = '**Error:** this tool only runs inside a Copilot bot chat.';

/**
 * The bot a tool argument names: an exact id, else an exact name (any case),
 * else the one bot whose name contains it. Null when nothing — or more than
 * one bot — matches, so a vague reference never picks the wrong bot.
 */
export function resolveBotRef(bots: readonly BotDto[], ref: string): BotDto | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const byId = bots.find((b) => b.id === ref.trim());
  if (byId) return byId;
  const exact = bots.filter((b) => b.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = bots.filter((b) => b.name.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0]! : null;
}

/** "Copilot, Deal Scout and CRM Concierge" — for a not-found message. */
export function botNameList(bots: readonly BotDto[]): string {
  return bots.map((b) => b.name).join(', ') || 'none';
}
