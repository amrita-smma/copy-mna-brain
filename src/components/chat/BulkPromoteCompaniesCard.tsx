"use client";

import { Fragment, useMemo, useState, useEffect } from "react";
import { ArrowUp, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SignalStatus = "pass" | "fail" | "warn";

export interface BulkPromoteSignal {
  label: string;
  value: string;
  status?: SignalStatus;
}

export interface BulkPromoteCandidate {
  id: string;
  name: string;
  current_stage: string | null;
  tags?: string[];
  reason: string;
  signals?: BulkPromoteSignal[];
  meta?: string;
}

export interface BulkPromoteApprovalPayload {
  approval_id?: string;
  title: string;
  description: string;
  target_stage: string;
  candidates: BulkPromoteCandidate[];
}

interface BulkPromoteCompaniesCardProps {
  payload: BulkPromoteApprovalPayload;
  className?: string;
}

type Status = "idle" | "submitting" | "resolved";

function renderInlineReason(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((segment, i) => {
    if (segment.startsWith("**") && segment.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-emerald-700 dark:text-emerald-400">
          {segment.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{segment}</Fragment>;
  });
}

function signalColor(status?: SignalStatus): string {
  if (status === "pass") return "text-emerald-700 dark:text-emerald-400 font-semibold";
  if (status === "fail") return "text-rose-700 dark:text-rose-400 font-semibold";
  if (status === "warn") return "text-amber-700 dark:text-amber-400 font-semibold";
  return "text-foreground";
}

export function BulkPromoteCompaniesCard({
  payload,
  className,
}: BulkPromoteCompaniesCardProps) {
  const allIds = useMemo(
    () => payload.candidates.map((c) => c.id),
    [payload.candidates],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));
  const [status, setStatus] = useState<Status>("idle");
  const [resolutionText, setResolutionText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Restore resolved state from localStorage across page reloads
  useEffect(() => {
    if (payload.approval_id) {
      const saved = localStorage.getItem(`bulk_promote_resolved_${payload.approval_id}`);
      if (saved) {
        setResolutionText(saved);
        setStatus("resolved");
      }
    }
  }, [payload.approval_id]);

  const total = payload.candidates.length;
  const selectedCount = selected.size;
  const isResolved = status === "resolved";
  const isSubmitting = status === "submitting";
  const targetStage = payload.target_stage;

  const toggle = (id: string) => {
    if (status !== "idle") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePromote = async () => {
    if (selectedCount === 0) return;
    setStatus("submitting");
    setError(null);
    const deals = payload.candidates
      .filter((c) => selected.has(c.id))
      .map((c) => ({ id: c.id, currentStage: c.current_stage ?? undefined }));
    try {
      const res = await fetch("/api/companies/promote-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deals, nextStage: targetStage }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const held = total - selectedCount;
      const noun = selectedCount === 1 ? "candidate" : "candidates";
      const text = `Approved — promoted ${selectedCount} ${noun} to ${targetStage}${
        held > 0 ? ` (held ${held})` : ""
      }.`;
      setResolutionText(text);
      setStatus("resolved");
      if (payload.approval_id) {
        localStorage.setItem(`bulk_promote_resolved_${payload.approval_id}`, text);
      }
      toast.success(`Promoted ${selectedCount} ${noun} to ${targetStage}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to promote";
      setError(message);
      setStatus("idle");
      toast.error("Failed to promote", { description: message });
    }
  };

  const handleHoldAll = () => {
    const text = `Held all ${total} candidates at current stage for next review.`;
    setResolutionText(text);
    setStatus("resolved");
    if (payload.approval_id) {
      localStorage.setItem(`bulk_promote_resolved_${payload.approval_id}`, text);
    }
  };

  return (
    <div
      data-testid="bulk-promote-card"
      className={cn(
        "w-full rounded-2xl border shadow-sm overflow-hidden transition-colors",
        isResolved
          ? "border-border bg-muted/40"
          : "border-emerald-200/70 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/70 via-teal-50/40 to-emerald-50/70 dark:from-emerald-950/30 dark:via-teal-950/20 dark:to-emerald-950/30",
        className,
      )}
    >
      <div
        className={cn(
          "h-1 transition-colors",
          isResolved
            ? "bg-emerald-500"
            : "bg-gradient-to-r from-emerald-500 to-teal-600",
        )}
      />
      <div className="p-5">
        <div
          className={cn(
            "inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase mb-2 transition-colors",
            isResolved
              ? "text-muted-foreground"
              : "text-emerald-700 dark:text-emerald-400",
          )}
        >
          {isResolved ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" />
          )}
          {isResolved
            ? "Resolved"
            : `Approval needed · Promote to ${targetStage}`}
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
            const dim = !isSelected;
            return (
              <div
                key={c.id}
                data-testid={`bulk-promote-candidate-${c.id}`}
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
                    : "cursor-pointer hover:bg-background/90 focus-visible:ring-2 focus-visible:ring-emerald-400",
                  dim && "opacity-55",
                )}
              >
                {!isResolved && (
                  <span
                    className={cn(
                      "flex-shrink-0 mt-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-md border-[1.5px] transition-colors",
                      isSelected
                        ? "bg-emerald-700 border-emerald-700 text-white"
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
                    {c.tags?.map((tag, i) => (
                      <span
                        key={`${c.id}-tag-${i}`}
                        className={cn(
                          "text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-[2px]",
                          i === 0
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
                        )}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="text-sm text-foreground leading-snug">
                    {renderInlineReason(c.reason)}
                  </div>
                  {c.signals && c.signals.length > 0 && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs">
                      {c.signals.map((s, i) => (
                        <span
                          key={`${c.id}-sig-${i}`}
                          className="inline-flex items-center gap-1"
                        >
                          <span className="text-muted-foreground">{s.label}</span>
                          <span className={signalColor(s.status)}>{s.value}</span>
                        </span>
                      ))}
                    </div>
                  )}
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
                data-testid="bulk-promote-confirm-button"
                onClick={handlePromote}
                disabled={isSubmitting || selectedCount === 0}
                className="bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Promoting…
                  </>
                ) : (
                  `Promote ${selectedCount} to ${targetStage}`
                )}
              </Button>
              <Button
                data-testid="bulk-promote-hold-all-button"
                variant="outline"
                onClick={handleHoldAll}
                disabled={isSubmitting}
              >
                Hold all
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
