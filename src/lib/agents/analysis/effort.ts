/**
 * Reasoning-effort tiers shown to the user. A tier is a closed pair of TWO
 * independent dials — which model runs, and how hard it thinks
 * (`output_config.effort`). Keeping them paired behind one enum is deliberate:
 * the graph cache is keyed by tier (see `getAgentGraph`), so a tier must stay a
 * complete discriminator of the underlying model. Never let model and effort be
 * set independently without widening that key.
 *
 * Imported by the runtime and by the graph cache key, so it depends on neither.
 */
import type { ChatAnthropic } from '@langchain/anthropic';
import { ADAPTIVE_SUMMARIZED_THINKING, BETWEEN_TOOLS_THINKING } from '@/lib/ai/thinking';
import {
  type EffortChoice,
  type ManualEffortChoice,
  maxEffort,
  asEffortChoice,
  asManualEffort,
} from '@/lib/chat/effortTiers';

export type { EffortChoice, ManualEffortChoice };
export { maxEffort, asEffortChoice, asManualEffort };

/** `output_config.effort` — the API's five-rung scale. */
export type OutputEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface EffortTier {
  model: string;
  effort: OutputEffort;
  /**
   * Wall-clock budget for ONE chat turn at this tier, enforced in the route by
   * an AbortSignal rather than by the platform.
   */
  turnBudgetMs: number;
  /**
   * Output ceiling for a single model call at this tier. Thinking tokens count
   * against it, so this is the real bound on how long one call can run — a
   * time budget without it is aspirational.
   */
  maxTokens: number;
  /**
   * The model's `thinking` setting, chosen per model family (`@/lib/ai/thinking`).
   *
   * The two Sonnet tiers run with NO up-front thinking (`between_tools`): the
   * model answers or calls its first tool straight away and reasons between
   * tool calls instead. Measured on the real chat prompt with stubbed tools,
   * three lookup/analysis questions, three runs each, cache warm: first
   * visible text went from a median 10.8 s to 1.5 s on `low` and 7.4 s to
   * 1.7 s on `medium`, and whole turns from 10.8 s to 7.1 s and 12.2 s to
   * 9.7 s. Tool choice and answers were unchanged. The cost is the reasoning
   * panel: `between_tools` takes no `display` field, so the thinking between
   * tool calls streams empty — the model's own text, which now comes first,
   * is the progress the user sees.
   *
   * The Opus tiers keep adaptive thinking with the summary shown: Opus 5.5
   * has no off switch, and the deep-analysis tiers are where up-front
   * reasoning earns its latency.
   */
  thinking: ChatAnthropic['thinking'];
}

/**
 * Must stay below `maxDuration` in src/app/api/chat/route.ts with enough slack
 * for the wrap-up call. Asserted in the tests.
 */
export const CHAT_TURN_BUDGET_CEILING_MS = 600_000;

export const EFFORT_TIERS: Record<EffortChoice, EffortTier> = {
  // Lookups, follow-ups, ordinary conversation. No up-front thinking: the
  // first tool call or the answer starts at once (see `thinking` above).
  low: {
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    turnBudgetMs: 90_000,
    maxTokens: 16_000,
    thinking: BETWEEN_TOOLS_THINKING,
  },
  // Multi-tool turns and attachments. Same: reasoning happens between tools.
  medium: {
    model: 'claude-sonnet-5-5',
    effort: 'high',
    turnBudgetMs: 180_000,
    maxTokens: 32_000,
    thinking: BETWEEN_TOOLS_THINKING,
  },
  // Analysis and authoring that wants the stronger model.
  high: {
    model: 'claude-opus-5-5',
    effort: 'high',
    turnBudgetMs: 300_000,
    maxTokens: 64_000,
    thinking: ADAPTIVE_SUMMARIZED_THINKING,
  },
  // Auto-only top rung.
  deep: {
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    turnBudgetMs: 420_000,
    maxTokens: 96_000,
    thinking: ADAPTIVE_SUMMARIZED_THINKING,
  },
};
