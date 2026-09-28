/**
 * Why the system paused a routine (MB-560), and how the UI says so.
 *
 * A routine with a pause reason is always `enabled = false`. A manual pause
 * (the enable/disable toggle) has no reason, which is what lets a rebind
 * resume system pauses without ever re-enabling a routine a person switched
 * off.
 *
 * Client-safe: imports only the LangChain-free registry (via agentLabel), so
 * the Workforce rail and the insight schedule dialog import it directly. Never
 * import it through `@/lib/routines`, whose barrel reaches the cron tick.
 */
import { describeInsightAgent } from '@/lib/insights/agentLabel';

export const ROUTINE_PAUSED_REASONS = ['agent_deprecated', 'agent_incompatible'] as const;

/**
 * - `agent_deprecated` — the insight's bound agent is deprecated in this
 *   release (set by the fire tick's sweep).
 * - `agent_incompatible` — the binding no longer fits the insight. Modelled
 *   for the "declared inputs" check, which is out of Phase 1, so nothing sets
 *   it yet; it pauses, refuses and resumes exactly like `agent_deprecated`.
 */
export type RoutinePausedReason = (typeof ROUTINE_PAUSED_REASONS)[number];

export function isRoutinePausedReason(value: unknown): value is RoutinePausedReason {
  return (
    typeof value === 'string' &&
    (ROUTINE_PAUSED_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The plain-words notice for a system-paused routine, naming the agent and its
 * successor when the registry has one. Null when the routine isn't paused for
 * a reason (running, or paused by hand).
 */
export function describeRoutinePause(
  reason: string | null | undefined,
  agentKey: string | null | undefined,
): string | null {
  if (!isRoutinePausedReason(reason)) return null;
  const agent = describeInsightAgent(agentKey);
  const handle = agent?.handle ?? 'the bound agent';
  if (reason === 'agent_deprecated') {
    const next = agent?.successorHandle
      ? `Rebind the insight to ${agent.successorHandle} to resume.`
      : 'Rebind the insight to resume.';
    return `Paused — ${handle} was deprecated. ${next}`;
  }
  return `Paused — ${handle} no longer fits this insight. Rebind the insight to resume.`;
}
