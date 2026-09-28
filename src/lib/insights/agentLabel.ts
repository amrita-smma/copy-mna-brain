import { getSectorAgent } from '@/lib/agents/sector/registry';

/** How an insight's bound (or stamped) sector agent is shown in the UI. */
export interface InsightAgentLabel {
  key: string;
  handle: string;
  name: string | null;
  sector: string | null;
  deprecated: boolean;
  /** The successor's handle, when a deprecated agent names one. */
  successorHandle: string | null;
}

/**
 * Resolve a stored agent key for display. Reads the LangChain-free registry
 * directly (it is static code, safe in the client bundle), and resolves
 * deprecated agents too, since an existing binding or stamp must keep showing.
 *
 * A key the registry doesn't know — which only happens if an entry was
 * removed against the registry's never-delete rule — still gets a handle, so
 * the face and history degrade to `@key` rather than hiding the binding.
 */
export function describeInsightAgent(
  agentKey: string | null | undefined,
): InsightAgentLabel | null {
  if (!agentKey) return null;
  const agent = getSectorAgent(agentKey);
  if (!agent) {
    return {
      key: agentKey,
      handle: `@${agentKey}`,
      name: null,
      sector: null,
      deprecated: false,
      successorHandle: null,
    };
  }
  const successor = agent.successorKey ? getSectorAgent(agent.successorKey) : undefined;
  return {
    key: agent.key,
    handle: agent.handle,
    name: agent.name,
    sector: agent.sector,
    deprecated: agent.deprecated,
    successorHandle: successor?.handle ?? null,
  };
}
