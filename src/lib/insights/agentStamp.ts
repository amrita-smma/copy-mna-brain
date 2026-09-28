import { getSectorAgent } from '@/lib/agents/sector/registry';

/** The sector agent stamped onto an insight version. */
export interface InsightAgentStamp {
  agentKey: string;
}

/**
 * Resolve the stamp for the sector agent that is about to produce a version,
 * from the registry. Callers that write versions (the chat edit path and the
 * workforce publish) resolve through here so every version is stamped the
 * same way.
 *
 * Deprecated agents still resolve, because an insight still bound to one keeps
 * running on it until it is rebound. Returns null for no key or for a key the
 * registry doesn't know, so the version is written unstamped.
 */
export function resolveInsightAgentStamp(
  agentKey: string | null | undefined,
): InsightAgentStamp | null {
  if (!agentKey) return null;
  const agent = getSectorAgent(agentKey);
  return agent ? { agentKey: agent.key } : null;
}

/**
 * The stamp for a version an agent tool writes, from the run's `configurable`
 * (MB-549): `agent_key` is set by the chat route from the thread's pinned
 * agent, never by a tool argument, so the model cannot choose the stamp. The
 * general CoPilot's `'general'` sentinel, a missing key and anything the
 * registry doesn't know all yield null.
 */
export function readConfiguredAgentStamp(
  configurable: Record<string, unknown> | undefined,
): InsightAgentStamp | null {
  const key = configurable?.agent_key;
  return typeof key === 'string' ? resolveInsightAgentStamp(key) : null;
}
