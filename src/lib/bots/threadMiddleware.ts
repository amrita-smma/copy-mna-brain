/**
 * What a permanent bot thread (RFC 02) needs on every turn: a prompt layered
 * over its flavour, every skill's tools, history summarization and context
 * editing. A bot thread never ends, so without summarization its history
 * would eventually overflow the context window.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { summarizationMiddleware } from 'langchain';
import type { AgentGraph, AgentMiddlewareList, AgentTurnOverride } from '@/lib/agents/analysis/runtime';
import { EFFORT_TIERS } from '@/lib/agents/analysis/effort';
import { assembleBotSystemPrompt, type BotPromptInput } from './prompt';
import { mergeBotTools } from './skills';

/** Summarize once the history passes this many tokens. */
export const BOT_SUMMARY_TRIGGER_TOKENS = 120_000;
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

/** The per-turn override that runs a bot on its flavour's cached graph. */
export function buildBotTurnOverride(
  graph: Pick<AgentGraph, 'getSystemPrompt' | 'getToolList'>,
  bot: BotPromptInput,
  middleware: AgentMiddlewareList = botThreadMiddleware(),
): AgentTurnOverride {
  return {
    systemPrompt: assembleBotSystemPrompt(graph.getSystemPrompt(), bot),
    toolList: mergeBotTools(graph.getToolList()),
    middleware,
    contextEditing: true,
  };
}
