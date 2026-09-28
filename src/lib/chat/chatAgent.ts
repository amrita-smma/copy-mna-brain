/**
 * Which agent a CoPilot thread runs on (MB-549), for every chat entrypoint.
 *
 * - A thread is resolved on its FIRST turn and pinned on
 *   `copilot_chats.agent_key`; every later turn reuses the pin, even if the user
 *   has since navigated elsewhere. One agent per thread.
 * - The server decides. The client only sends what it already sends
 *   (`page_context.insightId`); the insight is loaded workspace-scoped and its
 *   bound `agent_key` is checked against the registry. An unknown key, a
 *   missing insight or an insight from another workspace resolves to the
 *   general CoPilot. A deprecated agent that is still bound keeps resolving
 *   (PRD §4.1).
 * - A first turn from an insight with no sector agent runs on the general
 *   CoPilot and carries a one-turn system notice so the first answer says so
 *   (US-10 AC3).
 * - A sector thread runs on `getSectorAgentGraph(key, 'chat', effort)` and
 *   replaces the workspace's CoPilot flavour; a general thread keeps today's
 *   flavour logic.
 *
 * Enters the sector stack through `sector/graph` only — never `<agent>/tools`
 * or `sector/coreTools`, which hit the tools ↔ workforce-trigger import cycle.
 * Server-only: client code imports `./chatAgentKey` instead.
 */
import {
  getAgentGraph,
  type AgentGraph,
  type CopilotAgentType,
  type EffortChoice,
} from '@/lib/agents/analysis';
import { getSectorAgentGraph } from '@/lib/agents/sector/graph';
import { isSectorAgentKey, type SectorRegistry } from '@/lib/agents/sector/registry';
import type { CopilotChatsService } from '@/lib/services/copilotChatsService';
import type { InsightService } from '@/lib/services/insightService';
import { GENERAL_CHAT_AGENT, type ChatAgentKey } from './chatAgentKey';
import type { PageContext } from './pageContext';

/**
 * The one-turn system context for a first turn opened on an insight that has
 * no sector agent bound: the general CoPilot answers and says so up front.
 */
export const NO_SECTOR_AGENT_NOTICE = [
  '## No sector agent on this insight',
  '',
  'This conversation was opened from an insight that has no sector agent attached, so you are answering as the general CoPilot.',
  'Begin your reply by stating this in one short sentence — for example: "No sector agent is attached to this insight, so I\'m answering as the general CoPilot." Then answer the question as usual.',
].join('\n');

/**
 * The one-turn system context for a first turn opened on an insight whose bound
 * agent key is not in the registry: the insight still shows that binding, so
 * the notice must not claim none is attached.
 */
export const UNAVAILABLE_SECTOR_AGENT_NOTICE = [
  '## Sector agent unavailable on this insight',
  '',
  'This conversation was opened from an insight whose sector agent is no longer available, so you are answering as the general CoPilot.',
  'Begin your reply by stating this in one short sentence — for example: "This insight\'s sector agent is no longer available, so I\'m answering as the general CoPilot." Then answer the question as usual.',
].join('\n');

/** The fields of a `copilot_chats` row the resolver reads. */
export interface ChatAgentChat {
  id: string;
  agent_key: string | null;
}

export interface ChatAgentResolution {
  agentKey: ChatAgentKey;
  /**
   * Extra system context for THIS turn only — set on a first turn opened on an
   * unbound insight or one bound to an unknown key, null otherwise.
   */
  notice: string | null;
  /** True when this call resolved (and, with a chat, pinned) the agent. */
  firstTurn: boolean;
}

export interface ResolveChatAgentDeps {
  workspaceId: string;
  copilotChatsService: Pick<CopilotChatsService, 'pinAgent'>;
  insightService: Pick<InsightService, 'findBoundAgent'>;
  /** Injectable so deprecation can be tested against a fixture. */
  registry?: Pick<SectorRegistry, 'isSectorAgentKey'>;
}

type AgentKeyGuard = SectorRegistry['isSectorAgentKey'];

function narrow(isKey: AgentKeyGuard, value: string | null | undefined): ChatAgentKey {
  return isKey(value) ? value : GENERAL_CHAT_AGENT;
}

/** What a thread opened on this page would run on, without pinning anything. */
async function resolveFromPage(
  pageContext: PageContext | null,
  deps: Pick<ResolveChatAgentDeps, 'workspaceId' | 'insightService'>,
  isKey: AgentKeyGuard,
): Promise<Omit<ChatAgentResolution, 'firstTurn'>> {
  const insightId = pageContext?.insightId;
  if (!insightId) return { agentKey: GENERAL_CHAT_AGENT, notice: null };

  const bound = await deps.insightService.findBoundAgent(deps.workspaceId, insightId);
  // Missing, archived or another workspace's insight: treated as not being on
  // an insight at all — the general CoPilot, and nothing to announce.
  if (!bound) return { agentKey: GENERAL_CHAT_AGENT, notice: null };

  const agentKey = narrow(isKey, bound.agentKey);
  if (agentKey !== GENERAL_CHAT_AGENT) return { agentKey, notice: null };
  return {
    agentKey,
    notice: bound.agentKey ? UNAVAILABLE_SECTOR_AGENT_NOTICE : NO_SECTOR_AGENT_NOTICE,
  };
}

/**
 * Resolve the agent for one turn.
 *
 * - `chat` already pinned → the pin, no lookup.
 * - `chat` unresolved → resolve from `pageContext` and pin it. The pin is
 *   first-wins; when a concurrent turn pinned first, its agent is used and the
 *   notice dropped (it belongs to whichever turn actually resolved).
 * - `chat` null → a preview of what a new thread on this page would run on
 *   (the chat cache asks this before a thread exists). Nothing is pinned.
 */
export async function resolveChatAgentKey(
  { chat, pageContext }: { chat: ChatAgentChat | null; pageContext: PageContext | null },
  deps: ResolveChatAgentDeps,
): Promise<ChatAgentResolution> {
  const isKey = deps.registry?.isSectorAgentKey ?? isSectorAgentKey;

  if (chat?.agent_key) {
    return { agentKey: narrow(isKey, chat.agent_key), notice: null, firstTurn: false };
  }

  const fromPage = await resolveFromPage(pageContext, deps, isKey);
  if (!chat) return { ...fromPage, firstTurn: true };

  const pinned = await deps.copilotChatsService.pinAgent(chat.id, fromPage.agentKey);
  if (pinned && pinned !== fromPage.agentKey) {
    return { agentKey: narrow(isKey, pinned), notice: null, firstTurn: false };
  }
  return { ...fromPage, firstTurn: true };
}

export interface ChatAgentGraphOptions {
  effort?: EffortChoice;
  /** The workspace's CoPilot flavour. Used only by general threads. */
  flavour?: CopilotAgentType;
  /** Source-of-funds gate. Used only by general threads. */
  sof?: boolean;
}

export interface ChatAgentGraphBuilders {
  getAgentGraph: typeof getAgentGraph;
  getSectorAgentGraph: typeof getSectorAgentGraph;
}

const DEFAULT_BUILDERS: ChatAgentGraphBuilders = { getAgentGraph, getSectorAgentGraph };

/**
 * The graph a thread on `agentKey` runs on. Defaults match `getAgentGraph()`'s,
 * so callers with no workspace flavour to hand (the v1 API, and the read-only
 * paths — all graphs share one checkpointer, so any of them reads a thread's
 * history) behave exactly as before.
 */
export function getChatAgentGraph(
  agentKey: ChatAgentKey,
  { effort = 'medium', flavour = 'mna', sof = true }: ChatAgentGraphOptions = {},
  builders: ChatAgentGraphBuilders = DEFAULT_BUILDERS,
): Promise<AgentGraph | null> {
  return agentKey === GENERAL_CHAT_AGENT
    ? builders.getAgentGraph(flavour, effort, sof)
    : builders.getSectorAgentGraph(agentKey, 'chat', effort);
}

/**
 * Resolve (and on a first turn, pin) a thread's agent, then build its graph.
 * The one entrypoint `/api/chat` runs a turn through.
 */
export async function resolveChatAgentGraph(
  input: { chat: ChatAgentChat | null; pageContext: PageContext | null } & ChatAgentGraphOptions,
  deps: ResolveChatAgentDeps,
  builders: ChatAgentGraphBuilders = DEFAULT_BUILDERS,
): Promise<ChatAgentResolution & { graph: AgentGraph | null }> {
  const resolution = await resolveChatAgentKey(input, deps);
  const graph = await getChatAgentGraph(resolution.agentKey, input, builders);
  return { ...resolution, graph };
}
