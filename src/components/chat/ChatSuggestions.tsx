"use client";

import { TrendingUp, Briefcase, Activity, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useChatContext } from "./ChatProvider";

interface ChatSuggestion {
  label: string;
  prompt: string;
  icon: LucideIcon;
}

/**
 * Generic, always-available starter prompts shown in the chat empty state.
 * Clicking one fires the prompt straight to the assistant. Keep these broad
 * (no specific company / project names) so they make sense for any pipeline.
 */
const CHAT_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Pipeline Suggestions",
    prompt: "What suggestions do you have to improve my current pipeline?",
    icon: TrendingUp,
  },
  {
    label: "Active Deal Summary",
    prompt: "Give me a summary of all the active deals in the pipeline.",
    icon: Briefcase,
  },
  {
    label: "Pipeline Performance",
    prompt: "Summarize the pipeline performance and highlight any bottlenecks.",
    icon: Activity,
  },
  {
    label: "Stalled Deals",
    prompt: "Which deals have been stalled the longest, and why?",
    icon: Timer,
  },
];

export function ChatSuggestions({ className }: { className?: string }) {
  const { sendWithCacheCheck, status } = useChatContext();
  const isBusy = status === "streaming" || status === "submitted";

  return (
    <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", className)}>
      {CHAT_SUGGESTIONS.map((suggestion) => {
        const Icon = suggestion.icon;
        return (
          <button
            key={suggestion.label}
            type="button"
            disabled={isBusy}
            onClick={() => sendWithCacheCheck(suggestion.prompt)}
            className={cn(
              "group flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left",
              "transition-colors hover:border-purple-500/50 hover:bg-purple-500/5",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-purple-500/10">
              <Icon className="h-4 w-4 text-purple-500" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {suggestion.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
