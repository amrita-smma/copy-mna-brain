"use client";

import { TrendingUp, Briefcase, Activity, Timer, Search, Droplets, Target, Globe, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useChatActions, useChatStatus } from "./ChatProvider";
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

// Minority-stakes flavor: the same pipeline work the M&A flavor opens with —
// reviewing the pipeline, moving names forward, clearing stalled deals — each
// asked through the minority lens (sizing, concentration, protections, exit).
// This flavor reads the M&A tool set, so its suggestions must land on deal flow
// the pipeline tools can actually answer, not on portfolio theory alone.
const MINORITY_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Pipeline Review",
    prompt:
      "Summarize the active pipeline and tell me which opportunities work as minority stakes — and which only work with control.",
    icon: TrendingUp,
  },
  {
    label: "Exposure Impact",
    prompt:
      "If we took stakes in the companies currently at L1 and above, how would that change our sector and geography concentration?",
    icon: Briefcase,
  },
  {
    label: "Stake Screening",
    prompt:
      "Screen the L0 candidates as minority positions: entry multiple, likely stake size, what protections we'd need, and who else would be on the register.",
    icon: Target,
  },
  {
    label: "Stalled Deals",
    prompt:
      "Which deals have been stalled the longest, and for each one is it worth holding a small position or dropping it?",
    icon: Timer,
  },
];

// Crowdfunding flavor: the small-ticket book. Its opening questions are the
// four the prompt makes it ask in order — does it fit the mandate, what exactly
// is being funded, what is actually verified, and can the raise be filled —
// landed on the pipeline tools this flavor shares with the M&A set.
const CROWDFUNDING_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Mandate Screen",
    prompt:
      "Which companies in the pipeline fit the small-ticket mandate — a position of around Rp 10 billion into a total raise under Rp 20 billion — and which are too big for it?",
    icon: Target,
  },
  {
    label: "Perimeter Check",
    prompt:
      "Walk me through the perimeter check for funding one project inside a company rather than the whole company: what I need to establish, and what makes it an exposure to the parent instead.",
    icon: Briefcase,
  },
  {
    label: "Verify a Teaser",
    prompt:
      "Take the latest small-ticket teaser on file and split it into what is verified, what is only sponsor-stated, and what is modelled — with the document that would verify each one.",
    icon: Search,
  },
  {
    label: "Raise Structure",
    prompt:
      "How much of a Rp 18 billion funding need can actually be raised through crowdfunding under the current OJK rules, and what has to cover the rest?",
    icon: Activity,
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
  const { sendWithCacheCheck, prefillComposer, focusComposer } = useChatActions();
  const { status } = useChatStatus();
  const agentType = useCopilotAgent();
  const isBusy = status === "streaming" || status === "submitted";
  const baseSuggestions =
    agentType === "vc"
      ? VC_SUGGESTIONS
      : agentType === "investment"
        ? INVESTMENT_SUGGESTIONS
        : agentType === "combined"
          ? COMBINED_SUGGESTIONS
          : agentType === "minority"
            ? MINORITY_SUGGESTIONS
            : agentType === "crowdfunding"
              ? CROWDFUNDING_SUGGESTIONS
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
