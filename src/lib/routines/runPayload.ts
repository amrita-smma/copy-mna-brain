import type { RoutineRow } from '@/lib/repositories';
import { buildInsightRefreshPrompt } from './insightRefresh';
import { GENERAL_REFRESH_AGENT, ONE_OFF_REFRESH_FLAG, type RefreshAgentKey } from './refreshAgent';

export interface RoutineRunPayload {
  triggerMeta: Record<string, unknown>;
  input: Record<string, unknown>;
}

export function buildRoutineRunPayload(
  routine: Pick<RoutineRow, 'id' | 'title' | 'prompt' | 'insight_id'>,
  opts: {
    insightName: string | null;
    /**
     * The agent a refresh run runs on (MB-560), already resolved by the caller
     * with resolveRefreshAgentKey. Ignored for a routine with no insight.
     */
    agentKey?: string | null;
    baseTriggerMeta: Record<string, unknown>;
  },
): RoutineRunPayload {
  if (routine.insight_id == null) {
    return {
      triggerMeta: opts.baseTriggerMeta,
      input: {
        title: routine.title,
        instruction: routine.prompt,
        prompt: routine.prompt,
      },
    };
  }

  const wrapped = buildInsightRefreshPrompt({
    insightId: routine.insight_id,
    insightName: opts.insightName,
    userPrompt: routine.prompt,
  });

  return {
    triggerMeta: {
      ...opts.baseTriggerMeta,
      insight_id: routine.insight_id,
    },
    input: {
      title: routine.title,
      instruction: wrapped,
      prompt: wrapped,
      insight_id: routine.insight_id,
      // Read back by runAgent's load step; see src/lib/routines/refreshAgent.ts.
      agent_key: opts.agentKey ?? GENERAL_REFRESH_AGENT,
    },
  };
}

/** The longest insight name a one-off refresh run's title carries. */
const ONE_OFF_TITLE_NAME_CHARS = 120;

/**
 * A one-off refresh run for an insight with no refresh routine (MB-552): the
 * user accepted "Refresh this insight now" on a CoPilot card. It carries what
 * a routine's run carries — the wrapped prompt, `insight_id` and the resolved
 * `agent_key` — plus the `insight_refresh` flag, which is what makes runAgent
 * treat it as a refresh (draft edits, publish on success through MB-558)
 * without an `origin_routine_id`. The title is always non-empty, so the queue
 * never asks a model to write one.
 */
export function buildOneOffRefreshRunPayload(args: {
  insightId: string;
  insightName: string | null;
  agentKey: RefreshAgentKey;
  firedAt: string;
}): RoutineRunPayload {
  const wrapped = buildInsightRefreshPrompt({
    insightId: args.insightId,
    insightName: args.insightName,
    userPrompt: '',
  });
  const name = (args.insightName ?? '').trim().slice(0, ONE_OFF_TITLE_NAME_CHARS);
  return {
    triggerMeta: {
      insight_id: args.insightId,
      manual: true,
      [ONE_OFF_REFRESH_FLAG]: true,
      fired_at: args.firedAt,
    },
    input: {
      title: name ? `Refresh: ${name}` : 'Refresh insight',
      instruction: wrapped,
      prompt: wrapped,
      insight_id: args.insightId,
      agent_key: args.agentKey,
      [ONE_OFF_REFRESH_FLAG]: true,
    },
  };
}
