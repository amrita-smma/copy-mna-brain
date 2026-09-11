"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { FileSpreadsheet, Check, ArrowRight } from "lucide-react";
import type { WizardStep } from "./types";
import { cn } from "@/lib/utils";

interface StepHeaderProps {
  step: WizardStep;
  fileName: string;
  fileStatus?: string;
  readOnly?: boolean;
  templateId?: string | null;
  onStepClick?: (step: WizardStep) => void;
}

export function StepHeader({
  step,
  fileName,
  fileStatus,
  readOnly = false,
  templateId,
  onStepClick,
}: StepHeaderProps) {
  const isAwaitingReview = fileStatus === "awaiting_review" || !fileStatus;

  return (
    <div className="flex flex-col border-b border-border bg-background">
      {/* File info banner */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/60 bg-muted/30">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <FileSpreadsheet className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground" title={fileName}>
              {fileName}
            </span>
            {templateId ? (
              <Badge variant="outline" className="font-mono text-[10px]">
                {templateId}
              </Badge>
            ) : null}
            {fileStatus ? (
              <Badge
                variant={isAwaitingReview ? "secondary" : "default"}
                className={cn(
                  "text-[10px]",
                  isAwaitingReview
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-emerald-600 text-white",
                )}
              >
                {fileStatus === "awaiting_review" ? "Awaiting Review" : fileStatus}
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {readOnly
              ? "Read-only view · Historical verified ledger entries"
              : "Read with OCR & AI · nothing has been written to the ledger yet"}
          </p>
        </div>
      </div>

      {/* Step title & wizard progress bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {step === 1
              ? "Step 1 — Which records does this sheet mention?"
              : "Step 2 — Which rows should be added?"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {step === 1
              ? "Matched records are already in the database. New ones are held in memory until approved."
              : "Rows already on the books are skipped. Safe posting fields are editable before approval."}
          </p>
        </div>

        {/* Step dots */}
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => onStepClick?.(1)}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1 font-medium transition-colors",
              step === 1
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-mono",
                step === 1
                  ? "bg-primary text-primary-foreground"
                  : "bg-emerald-600 text-white",
              )}
            >
              {step === 1 ? "1" : <Check className="h-2.5 w-2.5 stroke-[3]" />}
            </span>
            <span>Entities</span>
          </button>

          <ArrowRight className="h-3 w-3 text-muted-foreground" />

          <button
            type="button"
            onClick={() => onStepClick?.(2)}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1 font-medium transition-colors",
              step === 2
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-mono",
                step === 2
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              2
            </span>
            <span>Ledger Rows</span>
          </button>
        </div>
      </div>
    </div>
  );
}
