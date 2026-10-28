"use client";

import { Fragment, useMemo, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApprovalResolution } from "./ApprovalCardShell";
import { CompanyNavigateButton } from "./CompanyChip";

export interface BulkDropCandidate {
  id: string;
  name: string;
  current_stage: string | null;
  tag?: string;
  reason: string;
  meta?: string;
}

export interface BulkDropApprovalPayload {
  approval_id?: string;
  title: string;
  description: string;
  candidates: BulkDropCandidate[];
}

interface BulkDropCompaniesCardProps {
  payload: BulkDropApprovalPayload;
  className?: string;
}

// Render a single-line reason string with inline **bold** segments. The agent
// uses these to highlight the killer signal (e.g. "-$4M EBITDA"). Plain text
// stays plain — no full markdown to keep the row a single visual line.
function renderInlineReason(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((segment, i) => {
    if (segment.startsWith("**") && segment.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-rose-700 dark:text-rose-400">
          {segment.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{segment}</Fragment>;
  });
}

export function BulkDropCompaniesCard({
  payload,
  className,
}: BulkDropCompaniesCardProps) {
  const allIds = useMemo(
    () => payload.candidates.map((c) => c.id),
    [payload.candidates],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));
  // The decision is stored with the chat (copilot_chat_cards), so it follows
  // the user across devices and reaches the agent's next turn.
  const { status, setStatus, resolutionText, error, setError, resolve } = useApprovalResolution({
    cardId: payload.approval_id,
    toolName: "propose_bulk_drop_companies",
  });

  const total = payload.candidates.length;
  const selectedCount = selected.size;
  const isResolved = status === "resolved";
  const isSubmitting = status === "submitting";

  const toggle = (id: string) => {
    if (status !== "idle") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDrop = async () => {
    if (selectedCount === 0) return;
    setStatus("submitting");
    setError(null);
    const deals = payload.candidates
      .filter((c) => selected.has(c.id))
      .map((c) => ({ id: c.id, currentStage: c.current_stage ?? undefined, reason: c.reason }));
    try {
      const res = await fetch("/api/companies/drop-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deals }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const kept = total - selectedCount;
      const noun = selectedCount === 1 ? "company" : "companies";
      const text = `Approved — dropped ${selectedCount} ${noun}${
        kept > 0 ? ` (kept ${kept})` : ""
      }.`;
      resolve(text, "accepted", { company_ids: deals.map((d) => d.id) });
      toast.success(`Dropped ${selectedCount} ${noun}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to drop";
      setError(message);
      setStatus("idle");
      toast.error("Failed to drop companies", { description: message });
    }
  };

  const handleKeepAll = () => {
    const text = `Kept all ${total} candidates on the watchlist.`;
    resolve(text, "declined");
  };

  return (
    <div
      data-testid="bulk-drop-card"
      className={cn(
        "w-full rounded-2xl border shadow-sm overflow-hidden transition-colors",
        isResolved
          ? "border-border bg-muted/40"
          : "border-rose-200/70 dark:border-rose-900/40 bg-gradient-to-br from-rose-50/70 via-orange-50/40 to-rose-50/70 dark:from-rose-950/30 dark:via-orange-950/20 dark:to-rose-950/30",
        className,
      )}
    >
      <div
        className={cn(
          "h-1 transition-colors",
          isResolved
            ? "bg-emerald-500"
            : "bg-gradient-to-r from-rose-500 to-rose-700",
        )}
      />
      <div className="p-5">
        <div
          className={cn(
            "inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase mb-2 transition-colors",
            isResolved
              ? "text-muted-foreground"
              : "text-rose-700 dark:text-rose-400",
          )}
        >
          {isResolved ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {isResolved ? "Resolved" : "Approval needed · Drop from pipeline"}
        </div>
        <h3 className="text-base font-semibold text-foreground mb-1.5">
          {payload.title}
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          {payload.description}
        </p>

        <div className="flex flex-col gap-2 mb-4">
          {payload.candidates.map((c) => {
            const isSelected = selected.has(c.id);
            const inert = isResolved || isSubmitting;
            const dim = isResolved ? !isSelected : !isSelected;
            return (
              <div
                key={c.id}
                data-testid={`bulk-drop-candidate-${c.id}`}
                role={inert ? undefined : "button"}
                tabIndex={inert ? undefined : 0}
                onClick={inert ? undefined : () => toggle(c.id)}
                onKeyDown={
                  inert
                    ? undefined
                    : (e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          toggle(c.id);
                        }
                      }
                }
                aria-pressed={inert ? undefined : isSelected}
                className={cn(
                  "rounded-lg border bg-background/70 px-3 py-3 flex gap-3 items-start transition-opacity outline-none",
                  inert
                    ? "cursor-default"
                    : "cursor-pointer hover:bg-background/90 focus-visible:ring-2 focus-visible:ring-rose-400",
                  dim && "opacity-55",
                )}
              >
                {!isResolved && (
                  <span
                    className={cn(
                      "flex-shrink-0 mt-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-md border-[1.5px] transition-colors",
                      isSelected
                        ? "bg-rose-700 border-rose-700 text-white"
                        : "bg-background border-border",
                    )}
                    aria-hidden
                  >
                    {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <span
                      className={cn(
                        "text-sm font-bold text-foreground",
                        dim && "line-through decoration-muted-foreground",
                      )}
                    >
                      {c.name}
                    </span>
                    <CompanyNavigateButton companyId={c.id} label={c.name} />
                    {c.tag && (
                      <span className="text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-[2px] bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                        {c.tag}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-foreground leading-snug">
                    {renderInlineReason(c.reason)}
                  </div>
                  {c.meta && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {c.meta}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {isResolved ? (
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400 rounded-lg border border-emerald-200/60 bg-emerald-50/60 dark:bg-emerald-950/30 px-3 py-2">
            <Check className="h-4 w-4" />
            <span>{resolutionText}</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              <strong className="text-foreground">{selectedCount}</strong> of {total} selected
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="bulk-drop-confirm-button"
                onClick={handleDrop}
                disabled={isSubmitting || selectedCount === 0}
                className="bg-gradient-to-r from-rose-500 to-rose-700 hover:from-rose-600 hover:to-rose-800 text-white"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Dropping…
                  </>
                ) : (
                  `Drop ${selectedCount} ${selectedCount === 1 ? "company" : "companies"}`
                )}
              </Button>
              <Button
                data-testid="bulk-drop-keep-all-button"
                variant="outline"
                onClick={handleKeepAll}
                disabled={isSubmitting}
              >
                Keep all
              </Button>
              {error && (
                <span className="text-xs text-destructive">{error}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
