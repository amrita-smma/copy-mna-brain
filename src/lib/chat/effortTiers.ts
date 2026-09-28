/**
 * Effort tiers and their narrowing guards, with no imports so client
 * components and the sandboxed workflow body can use them. The model/effort
 * config for each tier lives in `EFFORT_TIERS` in `@/lib/agents/analysis`.
 */

/** A TOTAL order, so `maxEffort` can enforce escalate-only routing. */
const TIER_ORDER = ['low', 'medium', 'high', 'deep'] as const;

export type EffortChoice = (typeof TIER_ORDER)[number];

/**
 * The tiers the user can pick by hand. `deep` is deliberately absent: it is
 * reachable only when Auto judges a turn worth it.
 */
export type ManualEffortChoice = Exclude<EffortChoice, 'deep'>;

/** The higher of two tiers. Auto may escalate a thread, never de-escalate it. */
export function maxEffort(a: EffortChoice, b: EffortChoice): EffortChoice {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * Narrow to any tier. Use for values the SERVER produced (the persisted
 * `copilot_chats.effort_tier`, the router's output), which may be `deep`.
 */
export function asEffortChoice(value: unknown): EffortChoice | null {
  return (TIER_ORDER as readonly unknown[]).includes(value) ? (value as EffortChoice) : null;
}

/**
 * Narrow to a tier a user may ask for. Use for every REQUEST BODY: a client
 * must not be able to pin a thread to `deep` by posting the string.
 */
export function asManualEffort(value: unknown): ManualEffortChoice | null {
  const tier = asEffortChoice(value);
  return tier === 'deep' ? null : tier;
}

/** Workforce runs never go below `medium`; anything unrecognised is `medium`. */
export function asWorkforceEffort(value: unknown): EffortChoice {
  return maxEffort(asEffortChoice(value) ?? 'medium', 'medium');
}
