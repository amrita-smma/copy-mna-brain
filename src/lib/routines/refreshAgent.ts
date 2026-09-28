/**
 * Which agent an insight refresh run runs on (MB-560, PRD §4.5 step 3).
 *
 * Resolved once, when the run row is created (scheduled fire and force-run
 * alike), and stored on the run's `input.agent_key`. The workflow reads it back
 * from the row, so a binding change applies from the next run and never
 * mid-run, a HITL resume continues on the graph whose checkpoint it paused, and
 * a run already in flight when its agent is deprecated finishes on that agent.
 * `input` rather than `trigger_meta` because a retry copies `input` and drops
 * `trigger_meta` — a retried refresh re-runs on the agent it first resolved.
 *
 * LangChain-free: imports only the sector registry, so the cron tick, the
 * routes and the workflow's load step can all use it.
 */
import {
  isSectorAgentKey,
  listSectorAgents,
  type SectorAgentKey,
} from '@/lib/agents/sector/registry';
import { isUuid } from '@/lib/uuid';

/** Stored on a refresh run that runs on today's general workforce agent. */
export const GENERAL_REFRESH_AGENT = 'general';

export type RefreshAgentKey = SectorAgentKey | typeof GENERAL_REFRESH_AGENT;

/**
 * The agent a refresh run of an insight bound to `boundKey` runs on. A registry
 * key — deprecated included, since an existing binding keeps resolving until it
 * is rebound — runs on that sector agent; unbound, or a key the registry
 * doesn't know, runs on the general workforce agent.
 */
export function resolveRefreshAgentKey(
  boundKey: string | null | undefined,
): RefreshAgentKey {
  return isSectorAgentKey(boundKey) ? boundKey : GENERAL_REFRESH_AGENT;
}

/**
 * The sector agent a run row says it runs on, or null for the general
 * workforce agent. Rows created before MB-560 carry no key and read as
 * general, which is what they ran on.
 */
export function readRunAgentKey(input: unknown): SectorAgentKey | null {
  if (typeof input !== 'object' || input === null) return null;
  const key = (input as Record<string, unknown>).agent_key;
  return isSectorAgentKey(key) ? key : null;
}

/** The registry keys marked deprecated in this release. */
export function listDeprecatedSectorAgentKeys(): SectorAgentKey[] {
  return listSectorAgents({ includeDeprecated: true })
    .filter((agent) => agent.deprecated)
    .map((agent) => agent.key);
}

/**
 * Set to `true` on a one-off refresh run's `input` (MB-552): a refresh the
 * user asked for from a CoPilot card on an insight that has no refresh
 * routine. Server-set only — no route copies a request body into `input` —
 * and in `input` because a retry copies `input` but not `trigger_meta`.
 */
export const ONE_OFF_REFRESH_FLAG = 'insight_refresh';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && isUuid(value) ? value : null;
}

/**
 * The insight a run refreshes, or null when it is not a refresh run. A run is
 * a refresh when it came from a routine (MB-557) or carries the one-off flag
 * (MB-552); either way the insight id is read from `trigger_meta`, then from
 * `input` (a retried run has only `input`). A bare `input.insight_id` without
 * a routine or the flag is not a refresh.
 */
export function readRefreshInsightId(row: {
  origin_routine_id: string | null | undefined;
  trigger_meta: unknown;
  input: unknown;
}): string | null {
  const input = asRecord(row.input);
  const isRefresh = Boolean(row.origin_routine_id) || input[ONE_OFF_REFRESH_FLAG] === true;
  if (!isRefresh) return null;
  return uuidOrNull(asRecord(row.trigger_meta).insight_id) ?? uuidOrNull(input.insight_id);
}
