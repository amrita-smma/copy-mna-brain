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
}

/**
 * Must stay below `maxDuration` in src/app/api/chat/route.ts with enough slack
 * for the wrap-up call. Asserted in the tests.
 */
export const CHAT_TURN_BUDGET_CEILING_MS = 600_000;

export const EFFORT_TIERS: Record<EffortChoice, EffortTier> = {
  // Lookups, follow-ups, ordinary conversation. Adaptive thinking still runs —
  // the model scales its own reasoning inside a cheaper band.
  low: {
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    turnBudgetMs: 90_000,
    maxTokens: 16_000,
  },
  // Multi-tool turns and attachments.
  medium: {
    model: 'claude-sonnet-5-5',
    effort: 'high',
    turnBudgetMs: 180_000,
    maxTokens: 32_000,
  },
  // Analysis and authoring that wants the stronger model.
  high: {
    model: 'claude-opus-5-5',
    effort: 'high',
    turnBudgetMs: 300_000,
    maxTokens: 64_000,
  },
  // Auto-only top rung.
  deep: {
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    turnBudgetMs: 420_000,
    maxTokens: 96_000,
  },
};
