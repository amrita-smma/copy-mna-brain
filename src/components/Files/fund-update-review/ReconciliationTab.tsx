"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";
import type { ReviewReconciliation } from "./types";
import { cn } from "@/lib/utils";

interface ReconciliationTabProps {
  reconciliations: ReviewReconciliation[];
}

export function ReconciliationTab({ reconciliations }: ReconciliationTabProps) {
  if (reconciliations.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        No reconciliation data available for this sheet.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6 overflow-y-auto">
      {/* Advisory Banner */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
        <Info className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div>
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            Advisory Reconciliation
          </p>
          <p className="mt-0.5 text-muted-foreground">
            Compares calculated ledger totals (commitments, paid-in cash, investments) against the summary sheet figures.
            Differences are strictly advisory for reference and <strong>never block approval</strong>.
          </p>
        </div>
      </div>

      {/* Reconciliation Table */}
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-[11px] text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5">Fund</th>
              <th className="px-4 py-2.5">Metric</th>
              <th className="px-4 py-2.5 text-right">Source (Summary)</th>
              <th className="px-4 py-2.5 text-right">Calculated (Ledger)</th>
              <th className="px-4 py-2.5 text-right">Difference</th>
              <th className="px-4 py-2.5 text-center">Status</th>
              <th className="px-4 py-2.5">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {reconciliations.map((r, idx) => {
              const diffText =
                r.diff === 0
                  ? "0"
                  : `${r.diff > 0 ? "+" : ""}${r.diff.toLocaleString()} ${r.currency || "CNY"}`;

              return (
                <tr key={idx} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground max-w-[200px] truncate" title={r.fund || "All Funds"}>
                    {r.fund || "All Funds"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.metricName}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {r.sourceValue.toLocaleString()} {r.currency || "CNY"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {r.calculatedValue.toLocaleString()} {r.currency || "CNY"}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 text-right font-mono font-medium",
                      r.isReconciled
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {diffText}
                    {r.diffPct > 0 ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">({r.diffPct}%)</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge
                      variant={r.isReconciled ? "default" : "outline"}
                      className={cn(
                        "text-[10px] whitespace-nowrap",
                        r.isReconciled
                          ? "bg-emerald-600 text-white hover:bg-emerald-600"
                          : "border-amber-500/50 text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {r.isReconciled ? "Reconciled" : "Advisory Diff"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground max-w-[300px]">
                    {r.notes || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
