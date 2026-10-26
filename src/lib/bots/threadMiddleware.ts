/**
 * What a permanent bot thread (RFC 02) needs on every turn: a prompt layered
 * over its flavour, every skill's tools and history summarization. A bot
 * thread never ends, so without summarization its history would eventually
 * overflow the context window.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { summarizationMiddleware } from 'langchain';
import type { AgentGraph, AgentMiddlewareList, AgentTurnOverride } from '@/lib/agents/analysis/runtime';
import { EFFORT_TIERS } from '@/lib/agents/analysis/effort';
import { BETWEEN_TOOLS_THINKING } from '@/lib/ai/thinking';
import { assembleBotSystemPrompt, type BotPromptInput } from './prompt';
import { mergeBotTools } from './skills';

/**
 * Summarize once the history passes this many tokens.
 *
 * Every model call re-reads the whole thread, so this bounds how much history
 * each turn carries. A summary rewrites the thread and so costs one
 * prompt-cache miss, which is why it is not lower; 60k keeps a long-running
 * thread to a few dozen turns between summaries while halving the ceiling
 * the old 120k trigger allowed.
 */
export const BOT_SUMMARY_TRIGGER_TOKENS = 60_000;
/** Recent messages kept verbatim after a summary. */
export const BOT_SUMMARY_KEEP_MESSAGES = 20;

let cachedMiddleware: AgentMiddlewareList | null = null;

/** Built once per process; the summarizer is a cheap Sonnet call. */
export function botThreadMiddleware(): AgentMiddlewareList {
  if (cachedMiddleware) return cachedMiddleware;
  const model = new ChatAnthropic({
    model: EFFORT_TIERS.low.model,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    maxTokens: 4096,
    temperature: undefined,
    // Sonnet 5.5 rejects the library's default `{type: 'disabled'}` with a
    // 400 (see `@/lib/ai/thinking`); this is its lowest valid setting, and a
    // summary needs no up-front reasoning.
    thinking: BETWEEN_TOOLS_THINKING,
  });
  cachedMiddleware = [
    summarizationMiddleware({
      model,
      trigger: { tokens: BOT_SUMMARY_TRIGGER_TOKENS },
      keep: { messages: BOT_SUMMARY_KEEP_MESSAGES },
    }),
  ];
  return cachedMiddleware;
}

/**
 * The per-turn override that runs a bot on its flavour's cached graph.
 *
 * Context editing stays **off**: clearing earlier tool results rewrites the
 * history, which invalidates the cached prefix from that point on, and a chat
 * turn is short enough that the cache is worth more than the cleared tokens
 * (`AgentConfig.contextEditing`). Summarization bounds the history instead.
 */
export function buildBotTurnOverride(
  graph: Pick<AgentGraph, 'getSystemPrompt' | 'getToolList'>,
  bot: BotPromptInput,
  middleware: AgentMiddlewareList = botThreadMiddleware(),
): AgentTurnOverride {
  return {
    systemPrompt: assembleBotSystemPrompt(graph.getSystemPrompt(), bot),
    toolList: mergeBotTools(graph.getToolList()),
    middleware,
    contextEditing: false,
  };
}
