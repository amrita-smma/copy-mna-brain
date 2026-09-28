/**
 * The agent a CoPilot thread runs on (MB-549), as stored on
 * `copilot_chats.agent_key`. Dependency-free apart from the LangChain-free
 * sector registry: ChatProvider and the CoPilot header import this, so it
 * must never reach `@/lib/agents/analysis`, `sector/graph` or a tool module.
 */
import {
  getSectorAgent,
  isSectorAgentKey,
  type SectorAgentKey,
} from '@/lib/agents/sector/registry';

/** The sentinel stored when a thread resolved to the workspace's general CoPilot. */
export const GENERAL_CHAT_AGENT = 'general';

export type ChatAgentKey = SectorAgentKey | typeof GENERAL_CHAT_AGENT;

/**
 * Narrow a stored or bound agent key to what a thread runs on. A registry key
 * (deprecated agents included — an existing binding keeps resolving, PRD §4.1)
 * stays itself; anything else, including a key the registry doesn't know,
 * reads as the general CoPilot.
 */
export function toChatAgentKey(value: string | null | undefined): ChatAgentKey {
  return isSectorAgentKey(value) ? value : GENERAL_CHAT_AGENT;
}

/** How the CoPilot header names the agent a thread runs on. */
export function describeChatAgent(key: ChatAgentKey): {
  key: ChatAgentKey;
  label: string;
  handle: string | null;
} {
  if (key === GENERAL_CHAT_AGENT) {
    return { key, label: 'General CoPilot', handle: null };
  }
  const agent = getSectorAgent(key);
  if (!agent) return { key, label: 'General CoPilot', handle: null };
  return { key, label: `${agent.handle} · ${agent.name}`, handle: agent.handle };
}
