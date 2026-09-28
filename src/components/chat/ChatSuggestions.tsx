"use client";

import { TrendingUp, Briefcase, Activity, Timer, Search, Droplets, Target, Globe, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useChatContext } from "./ChatProvider";
import { useCopilotAgent } from "./CopilotAgentContext";
import { INSIGHT_TEMPLATE_TRIGGER } from "@/lib/insights/insightSlashCommand";

interface ChatSuggestion {
  label: string;
  prompt: string;
  icon: LucideIcon;
  /**
   * Prefill the composer instead of sending immediately — for a suggestion
   * that opens a picker (e.g. the `/insight-template` popup) rather than one
   * that's a complete, ready-to-send question.
   */
  prefillOnly?: boolean;
}

const INSIGHT_TEMPLATE_SUGGESTION: ChatSuggestion = {
  label: "Create an insight from a template",
  prompt: `${INSIGHT_TEMPLATE_TRIGGER} `,
  icon: FileText,
  prefillOnly: true,
};

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

const VC_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Thesis Alignment",
    prompt: "Evaluate how well a target company aligns with our active workspace investment theses.",
    icon: Target,
  },
  {
    label: "Return Modeling",
    prompt: "Model downside, base, and upside investment return scenarios with MOIC and IRR.",
    icon: TrendingUp,
  },
  {
    label: "Holding Review",
    prompt: "Review the performance, valuation, and metrics of our internal fund holdings.",
    icon: Briefcase,
  },
  {
    label: "External Diligence",
    prompt: "Evaluate an external fund manager or company using cited market research.",
    icon: Globe,
  },
];

// Combined flavor: a mix that exercises both the deal pipeline and the fund
// portfolio so users see the assistant can move between the two.
const COMBINED_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Active Deal Summary",
    prompt: "Give me a summary of all the active deals in the pipeline.",
    icon: Briefcase,
  },
  {
    label: "Fund Performance",
    prompt: "Which fund has the best TVPI, and how do our holdings compare to market?",
    icon: TrendingUp,
  },
  {
    label: "Asset Analysis",
    prompt: "Give me a deep dive analysis of the fund assets and their performance.",
    icon: Search,
  },
  {
    label: "Cross-Portfolio View",
    prompt:
      "Compare our M&A pipeline against our fund portfolio — any overlap in sectors or companies?",
    icon: Globe,
  },
];

export function ChatSuggestions({ className }: { className?: string }) {
  const { sendWithCacheCheck, prefillComposer, focusComposer, status } = useChatContext();
  const agentType = useCopilotAgent();
  const isBusy = status === "streaming" || status === "submitted";
  const baseSuggestions =
    agentType === "vc"
      ? VC_SUGGESTIONS
      : agentType === "investment"
        ? INVESTMENT_SUGGESTIONS
        : agentType === "combined"
          ? COMBINED_SUGGESTIONS
          : MNA_SUGGESTIONS;
  const suggestions = [...baseSuggestions, INSIGHT_TEMPLATE_SUGGESTION];

  return (
    <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", className)}>
      {suggestions.map((suggestion) => {
        const Icon = suggestion.icon;
        return (
          <button
            key={suggestion.label}
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (suggestion.prefillOnly) {
                prefillComposer(suggestion.prompt);
                focusComposer();
              } else {
                sendWithCacheCheck(suggestion.prompt);
              }
            }}
            className={cn(
              "group flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left",
              "transition-colors hover:border-blue-500/50 hover:bg-blue-500/5",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
              <Icon className="h-4 w-4 text-blue-500" />
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
