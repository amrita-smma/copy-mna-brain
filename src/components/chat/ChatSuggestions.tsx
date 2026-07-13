"use client";

import { TrendingUp, Briefcase, Activity, Timer, Search, Droplets, Target, Globe } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useChatContext } from "./ChatProvider";
import { useCopilotAgent } from "./CopilotAgentContext";

interface ChatSuggestion {
  label: string;
  prompt: string;
  icon: LucideIcon;
}

const MNA_SUGGESTIONS: ChatSuggestion[] = [
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

const INVESTMENT_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Asset Analysis",
    prompt: "Give me a deep dive analysis of the fund assets and their performance.",
    icon: Search,
  },
  {
    label: "Liquidity Assessment",
    prompt: "Evaluate the current liquidity position across all fund assets.",
    icon: Droplets,
  },
  {
    label: "Strategy Evaluation",
    prompt: "Review and assess the current investment strategy and its alignment with fund objectives.",
    icon: Target,
  },
  {
    label: "Macroeconomic Comparison",
    prompt: "Compare this fund's performance against relevant macroeconomic benchmarks and market trends.",
    icon: Globe,
  },
];

export function ChatSuggestions({ className }: { className?: string }) {
  const { sendWithCacheCheck, status } = useChatContext();
  const agentType = useCopilotAgent();
  const isBusy = status === "streaming" || status === "submitted";
  const suggestions = agentType === "investment" ? INVESTMENT_SUGGESTIONS : MNA_SUGGESTIONS;

  return (
    <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", className)}>
      {suggestions.map((suggestion) => {
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
