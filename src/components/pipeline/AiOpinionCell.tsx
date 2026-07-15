"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  XCircle,
  HelpCircle,
  Sparkles,
  Loader2,
  RotateCcw,
} from "lucide-react";
import type { PipelineCompany } from "@/views/Pipeline";

/**
 * Right-most "AI Opinion" cell for the pipeline tables.
 *
 * States:
 *  - processing (status==='processing' or an optimistic local "analyzing"
 *    flag): spinner + "Analyzing…".
 *  - has verdict: pass → green check, fail → red cross, tentative → yellow
 *    question mark, plus the ≤50-word rationale and a "Re-evaluate" button.
 *  - empty: an "Analyze AI Opinion" button that hands the company to the
 *    AI Workforce.
 *
 * The verdict + summary live on the company row (ai_opinion_*), written by the
 * `save_ai_opinion` workforce tool; the parent polls the companies list so the
 * spinner swaps for the verdict automatically once the run completes.
 */

type Verdict = "pass" | "fail" | "tentative";

const VERDICT_META: Record<
  Verdict,
  { Icon: typeof CheckCircle2; className: string; label: string }
> = {
  pass: {
    Icon: CheckCircle2,
    className: "text-green-600 dark:text-green-400",
    label: "Pass",
  },
  fail: {
    Icon: XCircle,
    className: "text-red-600 dark:text-red-400",
    label: "Fail",
  },
  tentative: {
    Icon: HelpCircle,
    className: "text-amber-600 dark:text-amber-400",
    label: "Tentative",
  },
};

export function AiOpinionCell({
  company,
  analyzing,
  onAnalyze,
  onDiveDeeper,
}: {
  company: PipelineCompany;
  analyzing: boolean;
  onAnalyze: (company: PipelineCompany) => void;
  /**
   * Hand the existing verdict to the copilot for a deeper discussion. The
   * consumer sends the prompt and reveals the copilot pane.
   */
  onDiveDeeper?: (company: PipelineCompany) => void;
}) {
  const isProcessing = analyzing || company.ai_opinion_status === "processing";
  const verdict = company.ai_opinion_verdict as Verdict | null;

  if (isProcessing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
        Analyzing…
      </span>
    );
  }

  if (verdict && VERDICT_META[verdict]) {
    const { Icon, className, label } = VERDICT_META[verdict];
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-1.5">
          <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", className)} />
          <p
            className="text-xs text-muted-foreground whitespace-normal break-words leading-snug"
            title={company.ai_opinion_summary ?? label}
          >
            {company.ai_opinion_summary || label}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-fit gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onAnalyze(company)}
          >
            <RotateCcw className="h-3 w-3" />
            Re-evaluate
          </Button>
          {onDiveDeeper && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-fit gap-1 px-1.5 text-[11px] text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
              onClick={() => onDiveDeeper(company)}
            >
              <Sparkles className="h-3 w-3" />
              Dive deeper
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs text-blue-700 border-blue-200 hover:bg-blue-50 hover:text-blue-800 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-950/30"
        onClick={() => onAnalyze(company)}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Analyze AI Opinion
      </Button>
    </div>
  );
}
