'use client';

import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatContext } from '@/components/chat/ChatProvider';
import { useOpenInsightAgent } from '@/lib/chat/pageContextStore';
import {
  GENERAL_CHAT_AGENT,
  describeChatAgent,
  toChatAgentKey,
  type ChatAgentKey,
} from '@/lib/chat/chatAgentKey';

/**
 * Names the agent the CoPilot is running on (MB-549, US-10 AC2): the active
 * thread's pinned agent once its first turn has resolved it; before that, what
 * the open insight would resolve to; otherwise the general CoPilot. The server
 * stays the authority — this only mirrors what it pinned or will pin.
 */
export function ActiveAgentLabel({ className }: { className?: string }) {
  const { chatId, activeChatAgentKey } = useChatContext();
  const openInsight = useOpenInsightAgent();

  const agentKey: ChatAgentKey =
    chatId && activeChatAgentKey
      ? toChatAgentKey(activeChatAgentKey)
      : openInsight
        ? toChatAgentKey(openInsight.agentKey)
        : GENERAL_CHAT_AGENT;
  const { label, handle } = describeChatAgent(agentKey);
  // The handle never truncates — in the narrow docked header only the agent's
  // long name gives way, so the user can always tell which agent is active.
  const name = handle && label.startsWith(handle) ? label.slice(handle.length) : null;

  return (
    <span
      data-testid="copilot-active-agent"
      data-agent-key={agentKey}
      title={label}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground',
        className,
      )}
    >
      <Bot className="h-3 w-3 shrink-0" aria-hidden />
      {handle && name !== null ? (
        <>
          <span className="shrink-0">{handle}</span>
          <span className="min-w-0 truncate">{name}</span>
        </>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </span>
  );
}
