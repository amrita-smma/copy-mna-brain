"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  TrendingUp,
  Briefcase,
  Activity,
  Timer,
  Search,
  Droplets,
  Target,
  Globe,
  FileText,
  Sparkles,
  X,
} from "lucide-react";
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

// Investment-banking flavor: the advisory desk. Its opening questions are the
// ones a mandate actually starts with — which route, who would pay, what it is
// worth, and whether the route everyone wants is even available — landed on the
// pipeline and CRM tools this flavor shares with the M&A set.
const INVESTMENT_BANKING_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Strategic Alternatives",
    prompt:
      "For a company in our pipeline that wants liquidity within 12 months, compare the live routes — control sale, minority stake sale, IPO, bond issuance, recap, strategic partnership, and doing nothing — and recommend one.",
    icon: Target,
  },
  {
    label: "Buyer Universe",
    prompt:
      "Build a buyer universe for our largest active deal: named strategics and sponsors, why each would pay, and which of them we already have a relationship with.",
    icon: Globe,
  },
  {
    label: "Valuation Range",
    prompt:
      "Value a company in our pipeline on trading comparables and precedent transactions, give me a range per method with sources and dates, and say what would move it.",
    icon: TrendingUp,
  },
  {
    label: "Exit Readiness",
    prompt:
      "Which companies in the pipeline are realistically IPO-ready, which are only saleable, and what would have to be fixed first for each?",
    icon: Timer,
  },
];

// Capital-markets flavor: the DCM + ECM desk. Its opening questions start one
// step after the advisory decision — the issuer is raising, so the questions are
// instrument, capacity, pricing and window.
const CAPITAL_MARKETS_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Debt or Equity",
    prompt:
      "For a company in our pipeline raising expansion capital, work through debt versus equity: the instruments actually available, what each really costs, and which one I should recommend.",
    icon: Target,
  },
  {
    label: "Debt Capacity",
    prompt:
      "Assess the debt capacity of a company in our pipeline — leverage, coverage and headroom today and pro forma — and tell me which constraint binds first.",
    icon: Activity,
  },
  {
    label: "Indicative Pricing",
    prompt:
      "Price an indicative 5-year senior unsecured bond for one of our pipeline companies: benchmark, comparable recent prints with dates, the premium you are applying, and the all-in cost.",
    icon: TrendingUp,
  },
  {
    label: "Issuance Window",
    prompt:
      "Is the issuance window currently open for this sector in both debt and equity? Show me what has priced recently and what that implies for a raise in the next quarter.",
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

/** The starting points for the workspace's Copilot flavor, plus the insight-template opener. */
function useChatSuggestions(): ChatSuggestion[] {
  const agentType = useCopilotAgent();
  const base =
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
              : agentType === "investment_banking"
                ? INVESTMENT_BANKING_SUGGESTIONS
                : agentType === "capital_markets"
                  ? CAPITAL_MARKETS_SUGGESTIONS
                  : MNA_SUGGESTIONS;
  return [...base, INSIGHT_TEMPLATE_SUGGESTION];
}

/** localStorage key: the user folded the suggestions away (per browser, every bot). */
const COLLAPSED_STORAGE_KEY = "copilot.suggestionsCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the fold still works for this page.
  }
}

/**
 * Seconds each suggestion takes to cross: slow enough to read in passing. One
 * full loop is this times the number of suggestions.
 */
const SECONDS_PER_SUGGESTION = 6;

function SuggestionChips({
  suggestions,
  disabled,
  onPick,
  decorative = false,
  className,
}: {
  suggestions: readonly ChatSuggestion[];
  disabled: boolean;
  onPick: (suggestion: ChatSuggestion) => void;
  /** The seamless-loop copy: visible, clickable, but not announced or tabbable. */
  decorative?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 gap-2", className)} aria-hidden={decorative || undefined}>
      {suggestions.map((suggestion) => {
        const Icon = suggestion.icon;
        return (
          <button
            key={suggestion.label}
            type="button"
            disabled={disabled}
            tabIndex={decorative ? -1 : undefined}
            onClick={() => onPick(suggestion)}
            className={cn(
              "liquid-glass liquid-glass-quiet liquid-glass-control flex shrink-0 items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3 text-left",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/10">
              <Icon className="h-3.5 w-3.5 text-blue-500" />
            </span>
            <span className="whitespace-nowrap text-xs font-medium text-foreground">{suggestion.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The starting points as a slow carousel above the composer: the chips drift
 * right to left in a seamless loop, pausing under the pointer or keyboard
 * focus, and scroll by hand instead when the system asks for reduced motion.
 * The small × at the far right (in the send button's column) folds them away
 * into it; the sparkle it becomes brings them back. The fold is remembered per
 * browser. It stays through the conversation: the chips are shortcuts, not a
 * landing, so sending a message does not take them away.
 */
export function ChatSuggestionsCarousel({ className }: { className?: string }) {
  const { sendText, prefillComposer, focusComposer } = useChatActions();
  const { status } = useChatStatus();
  const suggestions = useChatSuggestions();
  const isBusy = status === "streaming" || status === "submitted";
  // Read after mount: the server has no storage, and the first paint must
  // match it.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const stored = readCollapsed();
    if (stored) setCollapsed(true);
  }, []);
  const toggle = () => {
    setCollapsed((current) => {
      writeCollapsed(!current);
      return !current;
    });
  };

  const pick = (suggestion: ChatSuggestion) => {
    if (suggestion.prefillOnly) {
      prefillComposer(suggestion.prompt);
      focusComposer();
    } else {
      sendText(suggestion.prompt);
    }
  };

  return (
    <div className={cn("flex min-h-7 items-center gap-2", className)} data-testid="chat-suggestions">
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="track"
            className={cn(
              "relative min-w-0 flex-1 overflow-hidden",
              // The ends fade out, so chips enter and leave softly.
              "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%_-_1.5rem),transparent)]",
              "motion-reduce:overflow-x-auto motion-reduce:[scrollbar-width:none]",
            )}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <div
              className={cn(
                "flex w-max gap-2 py-0.5 animate-marquee",
                "hover:[animation-play-state:paused] focus-within:[animation-play-state:paused]",
                "motion-reduce:animate-none",
              )}
              style={{ animationDuration: `${suggestions.length * SECONDS_PER_SUGGESTION}s` }}
            >
              <SuggestionChips suggestions={suggestions} disabled={isBusy} onPick={pick} />
              {/* The same chips once more: by the time the first set has
                  scrolled out, the second is where the first began, and the
                  loop restarts without a jump. Not under reduced motion,
                  where the row scrolls by hand instead. */}
              <SuggestionChips
                suggestions={suggestions}
                disabled={isBusy}
                onPick={pick}
                decorative
                className="motion-reduce:hidden"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Show suggestions" : "Hide suggestions"}
        title={collapsed ? "Show suggestions" : "Hide suggestions"}
        data-testid="chat-suggestions-toggle"
        className="liquid-glass liquid-glass-quiet liquid-glass-control ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <Sparkles className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
