"use client";

import type { UIMessage } from "@ai-sdk/react";
import { Button } from "@/components/ui/button";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { useChatContext } from "./ChatProvider";

/**
 * Inline preview shown when a brand-new chat repeats an earlier question. The
 * matched turn-1 is rendered as real chat bubbles — the user's question, then
 * the cached AI answer wrapped in a dotted border with two CTAs beneath it:
 *
 *   - Continue from chat → fork the cached turns into an owned chat + focus input
 *   - Start fresh        → discard the preview and run the agent normally
 *
 * Returns null when there's no active cache hit.
 */
export function CachedChatPreview() {
  const { cacheHit, continueFromCached, startFreshFromCached } = useChatContext();
  if (!cacheHit) return null;

  const userMessage: UIMessage = {
    id: "cached-user",
    role: "user",
    parts: [{ type: "text", text: cacheHit.pendingText }],
  };
  const aiMessage: UIMessage = {
    id: "cached-ai",
    role: "assistant",
    parts: [{ type: "text", text: cacheHit.firstAssistantMessage }],
  };
  const dateLabel = cacheHit.createdAt
    ? new Date(cacheHit.createdAt).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="min-w-0">
      <ChatMessageBubble message={userMessage} />
      <div className="mb-6 rounded-2xl border-2 border-dashed border-blue-300 p-3 dark:border-blue-700">
        <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">
          Cached chat history found{dateLabel ? ` on ${dateLabel}` : ""}
        </div>
        <ChatMessageBubble message={aiMessage} />
        <div className="flex flex-wrap justify-end gap-2 px-2 pt-1">
          <Button variant="outline" size="sm" onClick={startFreshFromCached}>
            Start fresh
          </Button>
          <Button
            size="sm"
            onClick={continueFromCached}
            className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600"
          >
            Continue from chat
          </Button>
        </div>
      </div>
    </div>
  );
}
