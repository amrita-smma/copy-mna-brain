/**
 * What a permanent bot thread (RFC 02) needs on every turn: a prompt layered
 * over its flavour, every skill's tools and history summarization. A bot
 * thread never ends, so without summarization its history would eventually
 * overflow the context window.
 */
import type { BaseMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { summarizationMiddleware } from 'langchain';
import { withLangfuseCallbacks } from '@/lib/langfuse';
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
/**
 * The mark past which a finished turn summarizes the thread in the
 * background (`summarizeThreadAhead`, `@/lib/bots/summarizeAhead`), so the
 * in-line trigger above — a summary call paid before the next turn's first
 * model call, a one-turn spike of ten seconds or more — is rarely reached:
 * a single turn would have to add a fifth of the ceiling for the thread to
 * cross it in line. The in-line trigger stays as the safety net.
 */
export const BOT_SUMMARY_AHEAD_TOKENS = Math.floor(BOT_SUMMARY_TRIGGER_TOKENS * 0.8);

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

/** What the middleware's `beforeModel` returns: the thread rewritten, or nothing to do. */
type SummarizationHook = (
  state: { messages: BaseMessage[] },
  runtime: Record<string, unknown>,
) => Promise<{ messages: BaseMessage[] } | undefined>;

/**
 * The thread's summary as the middleware would write it in line, computed
 * now at the lower mark: the messages update to apply (a remove-all, the
 * summary, the kept recent messages), or null when the thread is under it.
 * The same middleware instance does the work — its trigger is overridden
 * through the runtime context it reads, nothing else differs — so the
 * summary is the one the next turn would otherwise have paid for.
 */
export async function summarizeAheadUpdate(messages: BaseMessage[]): Promise<BaseMessage[] | null> {
  const [summarization] = botThreadMiddleware();
  const beforeModel = (summarization as unknown as { beforeModel?: SummarizationHook }).beforeModel;
  if (!beforeModel) return null;
  const result = await beforeModel(
    { messages },
    {
      context: { trigger: { tokens: BOT_SUMMARY_AHEAD_TOKENS } },
      ...withLangfuseCallbacks({ runName: 'chat.summarize_ahead' }),
    },
  );
  return result?.messages ?? null;
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
