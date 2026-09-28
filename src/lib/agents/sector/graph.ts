/**
 * Shared graph builder for the sector agents (MB-540/541). Reuses the analysis
 * agent's runtime — `buildAgentGraph` → `AgentGraph` → `createLocalAgent` →
 * langchain `createAgent`, streaming — with the sector agent's own prompt and
 * tool subset. No second agent runtime.
 *
 * Role composition:
 *   - chat — sector prompt + chat scaffolding (sector/rolePrompt.ts), the
 *     agent's chat tools, no middleware, checkpointed — like getAgentGraph.
 *   - workforce — sector prompt + the workforce report contract, the agent's
 *     workforce tools, the workforce HITL middleware (ask_owner) and context
 *     editing — exactly as getWorkforceAgentGraphForEffort builds it.
 *
 * Graphs are cached per `key:role:effort`, and `resetAgent()` clears the cache.
 *
 * Imports each agent's prompt and tools (never its index.ts, which imports
 * this module).
 */
import {
  WORKFORCE_HITL_MIDDLEWARE,
  buildAgentGraph,
  onResetAgent,
  type AgentGraph,
  type EffortChoice,
} from '@/lib/agents/analysis';
import { BANGUN_PROMPT } from '@/lib/agents/bangun/prompt';
import { BANGUN_TOOLS } from '@/lib/agents/bangun/tools';
import { DIKTI_PROMPT } from '@/lib/agents/dikti/prompt';
import { DIKTI_TOOLS } from '@/lib/agents/dikti/tools';
import { MINERBA_PROMPT } from '@/lib/agents/minerba/prompt';
import { MINERBA_TOOLS } from '@/lib/agents/minerba/tools';
import type { SectorToolSet } from './coreTools';
import { composeSectorRolePrompt } from './rolePrompt';
import type { SectorAgentKey, SectorAgentRole } from './types';

interface SectorAgentDefinition {
  prompt: string;
  tools: SectorToolSet;
}

const SECTOR_AGENT_DEFINITIONS: Record<SectorAgentKey, SectorAgentDefinition> = {
  minerba: { prompt: MINERBA_PROMPT, tools: MINERBA_TOOLS },
  dikti: { prompt: DIKTI_PROMPT, tools: DIKTI_TOOLS },
  bangun: { prompt: BANGUN_PROMPT, tools: BANGUN_TOOLS },
};

/** The tool list and full system prompt one sector agent runs with in one role. */
export function getSectorAgentSpec(key: SectorAgentKey, role: SectorAgentRole) {
  const definition = SECTOR_AGENT_DEFINITIONS[key];
  const tools = definition.tools[role];
  const systemPrompt = composeSectorRolePrompt(
    key,
    role,
    definition.prompt,
    tools.map((t) => t.name),
  );
  return { tools, systemPrompt };
}

const sectorAgentGraphs = new Map<string, AgentGraph>();
onResetAgent(() => sectorAgentGraphs.clear());

export async function getSectorAgentGraph(
  key: SectorAgentKey,
  role: SectorAgentRole,
  effort: EffortChoice = 'medium',
): Promise<AgentGraph | null> {
  const cacheKey = `${key}:${role}:${effort}`;
  const cached = sectorAgentGraphs.get(cacheKey);
  if (cached) return cached;

  const { tools, systemPrompt } = getSectorAgentSpec(key, role);
  const graph =
    role === 'workforce'
      ? await buildAgentGraph(tools, systemPrompt, [WORKFORCE_HITL_MIDDLEWARE], true, effort, true)
      : await buildAgentGraph(tools, systemPrompt, [], true, effort);
  if (graph) sectorAgentGraphs.set(cacheKey, graph);
  return graph;
}
