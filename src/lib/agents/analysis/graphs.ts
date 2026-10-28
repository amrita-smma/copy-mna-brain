/**
 * The built graphs and their caches: the Postgres checkpointer, the memoized
 * chat / workforce / stateless graphs, and the public getters the routes and
 * job handlers call.
 *
 * This is the only module that knows a flavor exists — and it knows it through
 * the registry (`./flavors`), not through a branch per flavor.
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

import { logger } from "../logger";
import {
  isLocalPostgresHost,
  parseExplicitDbFromEnv,
  rdsIamAuthToken,
  rdsIamDbAuthFromEnv,
} from "@/lib/server/db";
import {
  AgentGraph,
  createLocalAgent,
  type AgentMiddlewareList,
  type ThreadSnapshot,
} from "./runtime";
import { type EffortChoice } from "./effort";
import {
  CHAT_SYSTEM_PROMPT,
  DEFAULT_COPILOT_AGENT,
  defaultChatToolList,
  getCopilotFlavor,
} from "./flavors";
import type { CopilotAgentType, ToolList } from "./flavors/types";
import {
  WORKFORCE_HITL_MIDDLEWARE,
  WORKFORCE_SYSTEM_PROMPT,
  workforceToolList,
} from "./workforce";

const CHECKPOINT_SCHEMA = "agent_states";

// Chat graphs are keyed by `${agentType}:${effort}:sof=${sourceOfFundsEnabled}` — the workspace-selected
// Copilot flavor (a `CopilotAgentType`, see ./flavors) crossed with the effort tier ('low' |
// 'medium' | 'high'). The tier alone is a complete discriminator of the model + output_config pair
// (see EFFORT_TIERS), which is what keeps this key sound. Workforce graphs are keyed by effort. All share the same
// checkpointer; thread_id namespaces conversations (copilot_chats.id vs
// ai_workforce_queue.id).
const chatAgentGraphs = new Map<string, AgentGraph>();
const workforceAgentGraphs = new Map<EffortChoice, AgentGraph>();
let statelessAgentGraph: AgentGraph | null = null;
let checkpointerSetupPromise: Promise<PostgresSaver> | null = null;

/**
 * Lazily build (and `setup()`) a singleton PostgresSaver bound to the
 * `agent_states` schema. The first call runs the library's idempotent
 * setup() — every call after that resolves to the same instance.
 *
 * Connection config follows the same pattern as `src/lib/server/db.ts`:
 * discrete `DB_*` env vars + `RDS_IAM_DB_AUTH` to switch between static
 * password and rotating IAM token auth. `pg.Pool`'s `password` option accepts
 * an async function, which is called on every new connection — perfect for
 * IAM tokens that expire every 15 minutes.
 */
function getCheckpointer(): Promise<PostgresSaver> | null {
  let explicitDb;
  try {
    explicitDb = parseExplicitDbFromEnv();
  } catch (err) {
    logger.error((err as Error).message);
    return null;
  }
  const useIam = rdsIamDbAuthFromEnv();

  if (useIam && explicitDb.password) {
    logger.error(
      "With RDS_IAM_DB_AUTH, leave DB_PASSWORD empty; the app uses an IAM token.",
    );
    return null;
  }
  if (!useIam && explicitDb.password === undefined) {
    logger.error("Without RDS_IAM_DB_AUTH, set DB_PASSWORD.");
    return null;
  }

  if (checkpointerSetupPromise) return checkpointerSetupPromise;

  checkpointerSetupPromise = (async () => {
    const isLocal = isLocalPostgresHost(explicitDb.host);
    const pool = new pg.Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: useIam
        ? () =>
            rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user)
        : explicitDb.password!,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    const saver = new PostgresSaver(pool, undefined, {
      schema: CHECKPOINT_SCHEMA,
    });
    await saver.setup();
    logger.info(
      `✓ PostgresSaver ready (schema: ${CHECKPOINT_SCHEMA}, ssl: ${!isLocal}, iam: ${useIam})`,
    );
    return saver;
  })().catch((err) => {
    // Reset on failure so the next caller retries instead of inheriting the
    // rejected promise forever.
    checkpointerSetupPromise = null;
    throw err;
  });

  return checkpointerSetupPromise;
}

export async function buildAgentGraph(
  toolList: ToolList,
  systemPrompt: string,
  middleware: AgentMiddlewareList = [],
  useCheckpointer = true,
  effort: EffortChoice = 'medium',
  contextEditing?: boolean,
): Promise<AgentGraph | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY environment variable is required");
    return null;
  }

  try {
    // Only copilot chat and the workforce queue need persisted state (resumable
    // threads / HITL). One-shot job handlers (screening, analysis) run stateless
    // — no checkpointer, so no `agent_states` writes and no thread_id required.
    const checkpointerPromise = useCheckpointer ? getCheckpointer() : null;
    const checkpointer = checkpointerPromise
      ? await checkpointerPromise
      : undefined;
    return new AgentGraph(
      { apiKey, checkpointer, effort, contextEditing },
      toolList,
      systemPrompt,
      middleware,
    );
  } catch (error) {
    logger.error(`Failed to create agent: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Singleton(s) for the copilot chat agent, keyed by the workspace-selected
 * flavor crossed with the effort tier.
 *
 * The flavor supplies the tool list and the system prompt, and this function
 * does not know (or branch on) which one it got: `getCopilotFlavor` resolves it
 * from the registry in `./flavors`, which is where each flavor is described and
 * where a new one is added.
 *
 * `effort` selects a tier from EFFORT_TIERS — both the model and its
 * `output_config.effort`. All flavors share the same PostgresSaver checkpointer, so a thread's
 * persisted history is readable regardless of which flavor/effort is active.
 * The chat route resolves the flavor from `workspaces.copilot_agent` and the
 * effort from the request.
 */
export async function getAgentGraph(
  agentType: CopilotAgentType = DEFAULT_COPILOT_AGENT,
  effort: EffortChoice = "medium",
  sourceOfFundsEnabled = true,
): Promise<AgentGraph | null> {
  // Source-of-funds tracking is a per-workspace setting (admin Funds tab). When
  // off, the workspace's Copilot must not be able to query the funding_sources
  // table, so strip `query_fund_sources` from the tool set. Keyed into the
  // cache so a flag flip yields a distinct graph rather than a stale one.
  // `search_investments` stays in the list either way — it re-reads the same
  // flag itself and drops the capital-source section when it is off.
  const key = `${agentType}:${effort}:sof=${sourceOfFundsEnabled}`;
  const cached = chatAgentGraphs.get(key);
  if (cached) return cached;
  const flavor = getCopilotFlavor(agentType);
  const baseToolList = flavor.toolList();
  const toolList = sourceOfFundsEnabled
    ? baseToolList
    : baseToolList.filter((t) => t.name !== "query_fund_sources");
  const graph = await buildAgentGraph(toolList, flavor.systemPrompt, [], true, effort);
  if (graph) chatAgentGraphs.set(key, graph);
  return chatAgentGraphs.get(key) ?? null;
}

/**
 * A thread's persisted history (`AgentGraph.getThreadSnapshot`) read before
 * the graph it will run on is known.
 *
 * The chat route picks its tier from the effort router's answer, and the
 * graph from the tier; reading the history through that graph put the
 * checkpoint read — the longest of the turn's reads on a long thread — behind
 * the router as well. Every chat graph (the Copilot flavors here, the sector
 * agents' chat graphs in `sector/graph.ts`) shares the one checkpointer and
 * is compiled with no middleware, so they all read a thread identically —
 * a sector thread's history read here matches what its own graph would
 * read. The pool this picks from is this module's Copilot flavor cache: the
 * read goes through whichever flavor graph the process has already built,
 * or the default one. Not for workforce threads — those graphs carry the
 * HITL middleware, whose node the chat graphs lack, and their callers hold
 * their own graph.
 */
export async function readThreadSnapshot(threadId: string): Promise<ThreadSnapshot> {
  const reader = chatAgentGraphs.values().next().value ?? (await getAgentGraph());
  if (!reader) {
    throw new Error("No chat agent graph is available to read the thread (see the errors logged above)");
  }
  return reader.getThreadSnapshot(threadId);
}

/** @deprecated Use getAgentGraph('mna', effort) */
export async function getAgentGraphForModel(
  effort: EffortChoice = "medium",
): Promise<AgentGraph | null> {
  return getAgentGraph("mna", effort);
}

/**
 * Singleton for one-shot job handlers (AI screening, company analysis, market
 * screening). Same tools and system prompt as the copilot chat agent, but
 * built WITHOUT a checkpointer: these runs are stateless, single-turn
 * evaluations that never resume, so there is nothing to persist. This avoids
 * spinning up the `agent_states` PostgresSaver for paths that don't need it.
 */
export async function getStatelessAgentGraph(): Promise<AgentGraph | null> {
  if (statelessAgentGraph) return statelessAgentGraph;
  const graph = await buildAgentGraph(
    defaultChatToolList(),
    CHAT_SYSTEM_PROMPT,
    [],
    false,
  );
  if (graph) statelessAgentGraph = graph;
  return statelessAgentGraph;
}

/**
 * Singleton for the workforce agent at a specific effort tier. Uses base +
 * workforce-only tools and the terse "execute and report" system prompt.
 */
export async function getWorkforceAgentGraphForEffort(
  effort: EffortChoice = 'medium',
): Promise<AgentGraph | null> {
  const cached = workforceAgentGraphs.get(effort);
  if (cached) return cached;
  const graph = await buildAgentGraph(
    workforceToolList(),
    WORKFORCE_SYSTEM_PROMPT,
    [WORKFORCE_HITL_MIDDLEWARE],
    true,
    effort,
    true,
  );
  if (graph) workforceAgentGraphs.set(effort, graph);
  return workforceAgentGraphs.get(effort) ?? null;
}

/** @deprecated Use getWorkforceAgentGraphForEffort('medium') */
export async function getWorkforceAgentGraph(): Promise<AgentGraph | null> {
  return getWorkforceAgentGraphForEffort('medium');
}

/**
 * Caches built outside this module (the sector agent graphs in
 * src/lib/agents/sector/graph.ts) register a clear function here so
 * `resetAgent()` drops them too. A listener, rather than an import, because
 * the sector module imports this one — importing back would be a cycle.
 */
const resetListeners = new Set<() => void>();

export function onResetAgent(listener: () => void): void {
  resetListeners.add(listener);
}

export function resetAgent(): void {
  chatAgentGraphs.clear();
  workforceAgentGraphs.clear();
  statelessAgentGraph = null;
  checkpointerSetupPromise = null;
  for (const listener of resetListeners) listener();
}
