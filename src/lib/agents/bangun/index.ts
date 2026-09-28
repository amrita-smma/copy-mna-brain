/**
 * @bangun entrypoint. The graph is built by the shared sector builder
 * (sector/graph.ts) on the analysis agent's runtime, which uses langchain
 * `createAgent` and streams (streamEvents for chat, streamed invoke for the
 * workforce).
 */
import type { AgentGraph, EffortChoice } from '@/lib/agents/analysis';
import { getSectorAgentGraph } from '@/lib/agents/sector/graph';
import type { SectorAgentRole } from '@/lib/agents/sector/types';

export function getBangunAgentGraph(
  role: SectorAgentRole,
  effort: EffortChoice = 'medium',
): Promise<AgentGraph | null> {
  return getSectorAgentGraph('bangun', role, effort);
}
