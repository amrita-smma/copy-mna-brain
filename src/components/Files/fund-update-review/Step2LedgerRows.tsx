"use client";

import React, { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import type {
  ReviewOption,
  ReviewReconciliation,
  ReviewTransaction,
  ReviewValuation,
  Step2TabKind,
} from "./types";
import { TransactionsTable } from "./TransactionsTable";
import { ValuationsTable } from "./ValuationsTable";
import { ReconciliationTab } from "./ReconciliationTab";
import { cn } from "@/lib/utils";

interface Step2LedgerRowsProps {
  transactions: ReviewTransaction[];
  valuations: ReviewValuation[];
  reconciliations: ReviewReconciliation[];
  entityOptions: ReviewOption[];
  sourceOptions: ReviewOption[];
  stagedEntityCount: number;
  onToggleSelectTxn: (id: string, selected: boolean) => void;
  onToggleSelectVal: (id: string, selected: boolean) => void;
  onToggleAllTxns: (selected: boolean) => void;
  onToggleAllVals: (selected: boolean) => void;
  onUpdateTxn: (id: string, updates: Partial<ReviewTransaction>) => void;
  onUpdateValuation: (id: string, updates: Partial<ReviewValuation>) => void;
  readOnly?: boolean;
}

export function Step2LedgerRows({
  transactions,
  valuations,
  reconciliations,
  entityOptions,
  sourceOptions,
  stagedEntityCount,
  onToggleSelectTxn,
  onToggleSelectVal,
  onToggleAllTxns,
  onToggleAllVals,
  onUpdateTxn,
  onUpdateValuation,
  readOnly = false,
}: Step2LedgerRowsProps) {
  const [activeTab, setActiveTab] = useState<Step2TabKind>("transactions");

  // Counts for transactions
  const txnStats = useMemo(() => {
    const actionable = transactions.filter((t) => t.status === "actionable");
    const selectedActionable = actionable.filter((t) => t.selected);
    const duplicates = transactions.filter((t) => t.status === "duplicate").length;
    const blocked = transactions.filter((t) => t.status === "blocked").length;

    return {
      total: transactions.length,
      actionableCount: actionable.length,
      selectedCount: selectedActionable.length,
      duplicates,
      blocked,
      allChecked: actionable.length > 0 && selectedActionable.length === actionable.length,
      someChecked: selectedActionable.length > 0 && selectedActionable.length < actionable.length,
    };
  }, [transactions]);

  // Counts for valuations
  const valStats = useMemo(() => {
    const actionable = valuations.filter((v) => v.status === "actionable");
    const selectedActionable = actionable.filter((v) => v.selected);
    const duplicates = valuations.filter((v) => v.status === "duplicate").length;
    const blocked = valuations.filter((v) => v.status === "blocked").length;

    return {
      total: valuations.length,
      actionableCount: actionable.length,
      selectedCount: selectedActionable.length,
      duplicates,
      blocked,
      allChecked: actionable.length > 0 && selectedActionable.length === actionable.length,
      someChecked: selectedActionable.length > 0 && selectedActionable.length < actionable.length,
    };
  }, [valuations]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Top bar with sub-tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-2.5 bg-muted/20">
        <div className="inline-flex rounded-full border border-border bg-muted/40 p-0.5">
          <button
            type="button"
            onClick={() => setActiveTab("transactions")}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
              activeTab === "transactions"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>Transactions</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.2 text-[10px]",
                activeTab === "transactions"
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {transactions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("valuations")}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
              activeTab === "valuations"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>Valuations</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.2 text-[10px]",
                activeTab === "valuations"
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {valuations.length}
            </span>
          </button>

          {reconciliations.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab("reconciliation")}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
                activeTab === "reconciliation"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>Reconciliation</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.2 text-[10px]",
                  activeTab === "reconciliation"
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {reconciliations.length}
              </span>
            </button>
          )}
        </div>

        {/* Stats & Help Text */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {stagedEntityCount > 0 && (
            <span className="hidden sm:inline">
              Using <strong className="text-foreground">{stagedEntityCount}</strong> entity record
              {stagedEntityCount === 1 ? "" : "s"} staged in Step 1
            </span>
          )}
          {!readOnly && (
            <span className="text-[11px] font-medium text-primary">
              Safe posting fields are editable before approval
            </span>
          )}
        </div>
      </div>

      {/* Action Sub-Bar */}
      {activeTab !== "reconciliation" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-6 py-2 text-xs text-muted-foreground">
          {!readOnly && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all-addable"
                checked={
                  activeTab === "transactions"
                    ? txnStats.allChecked
                      ? true
                      : txnStats.someChecked
                        ? "indeterminate"
                        : false
                    : valStats.allChecked
                      ? true
                      : valStats.someChecked
                        ? "indeterminate"
                        : false
                }
                disabled={
                  activeTab === "transactions"
                    ? txnStats.actionableCount === 0
                    : valStats.actionableCount === 0
                }
                onCheckedChange={(c) => {
                  if (activeTab === "transactions") {
                    onToggleAllTxns(Boolean(c));
                  } else {
                    onToggleAllVals(Boolean(c));
                  }
                }}
              />
              <label
                htmlFor="select-all-addable"
                className="cursor-pointer font-medium text-foreground"
              >
                Select all addable ({activeTab === "transactions" ? txnStats.selectedCount : valStats.selectedCount} of {activeTab === "transactions" ? txnStats.actionableCount : valStats.actionableCount} selected)
              </label>
            </div>
          )}

          <div className="flex items-center gap-2.5 text-[11px]">
            {activeTab === "transactions" ? (
              <>
                <span>
                  <strong className="text-foreground">{txnStats.actionableCount}</strong> new / actionable
                </span>
                <span>·</span>
                <span>{txnStats.duplicates} duplicate / in system</span>
                {txnStats.blocked > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-destructive font-medium">{txnStats.blocked} blocked</span>
                  </>
                )}
              </>
            ) : (
              <>
                <span>
                  <strong className="text-foreground">{valStats.actionableCount}</strong> new / actionable
                </span>
                <span>·</span>
                <span>{valStats.duplicates} duplicate / in system</span>
                {valStats.blocked > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-destructive font-medium">{valStats.blocked} blocked</span>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Main Grid Pane */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {activeTab === "transactions" && (
          <TransactionsTable
            transactions={transactions}
            entityOptions={entityOptions}
            sourceOptions={sourceOptions}
            onToggleSelect={onToggleSelectTxn}
            onUpdateTxn={onUpdateTxn}
            readOnly={readOnly}
          />
        )}

        {activeTab === "valuations" && (
          <ValuationsTable
            valuations={valuations}
            onToggleSelect={onToggleSelectVal}
            onUpdateValuation={onUpdateValuation}
            readOnly={readOnly}
          />
        )}

        {activeTab === "reconciliation" && (
          <ReconciliationTab reconciliations={reconciliations} />
        )}
      </div>

      {/* Legend Footer */}
      {activeTab !== "reconciliation" && (
        <div className="border-t border-border bg-muted/20 px-6 py-2 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-xs bg-muted border border-border" />
              <span>Greyed = already in the ledger / skipped</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-xs bg-destructive/20 border border-destructive/40" />
              <span>Red = blocked (missing entity or incomplete resolution)</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-xs bg-emerald-500/20 border border-emerald-500/40" />
              <span>Green = resolved ambiguous event</span>
            </span>
            <span className="italic ml-auto">Hover any row to inspect detail reason.</span>
          </div>
        </div>
      )}
    </div>
  );
}
