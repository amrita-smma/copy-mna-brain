"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type {
  EntityTabKind,
  FundUpdateReviewData,
  ReviewEntity,
  ReviewOption,
  ReviewReconciliation,
  ReviewTransaction,
  ReviewValuation,
  WizardStep,
} from "./fund-update-review/types";
import {
  buildApprovePayload,
  extractTwoStepReview,
  formatApprovalFeedback,
  getEntityOptions,
} from "./fund-update-review/adapter";
import {
  applyTransactionUpdate,
  recomputeTransactionsAndValuations,
} from "./fund-update-review/validation";
import { StepHeader } from "./fund-update-review/StepHeader";
import { Step1Entities } from "./fund-update-review/Step1Entities";
import { Step2LedgerRows } from "./fund-update-review/Step2LedgerRows";
import { StepFooter } from "./fund-update-review/StepFooter";

export type {
  AssetStatus,
  FundUpdateAssetReview,
  FundUpdateAssetStatus,
  FundUpdateCatalogKind,
  FundUpdateCatalogMatch,
  FundUpdateCatalogMatchStatus,
  FundUpdateReviewData,
  FundUpdateTwoStepReview,
} from "./fund-update-review/types";

interface Props {
  fileId: string;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
  /** Browse-only: view parsed data without approve / selection UI. */
  readOnly?: boolean;
}

export function FundUpdateReviewDialog({
  fileId,
  open,
  onClose,
  onApproved,
  readOnly: explicitReadOnly = false,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FundUpdateReviewData | null>(null);

  // Wizard state
  const [step, setStep] = useState<WizardStep>(1);
  const [activeEntityTab, setActiveEntityTab] = useState<EntityTabKind>("asset");
  const [selectedEntityKey, setSelectedEntityKey] = useState<string | null>(null);

  // Normalized review data state
  const [entities, setEntities] = useState<ReviewEntity[]>([]);
  const [transactions, setTransactions] = useState<ReviewTransaction[]>([]);
  const [valuations, setValuations] = useState<ReviewValuation[]>([]);
  const [reconciliations, setReconciliations] = useState<ReviewReconciliation[]>([]);

  // Only awaiting-review imports are mutable. Every other lifecycle state is
  // browse-only, even if the caller omitted the explicit readOnly prop.
  const isReadOnly = useMemo(() => {
    if (explicitReadOnly) return true;
    return data?.file?.processing_status !== "awaiting_review";
  }, [explicitReadOnly, data?.file?.processing_status]);

  // Load review data on open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      setStep(1);

      try {
        const res = await fetch(`/api/smart-files/${fileId}/review`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load review data");
        if (cancelled) return;

        const payload = json.data as FundUpdateReviewData;
        if (payload.kind !== "fund_updates") {
          throw new Error("This file is not a Fund Updates review");
        }

        setData(payload);

        // Extract canonical two-step review model (authoritative from server)
        const twoStep = extractTwoStepReview(payload);
        const entityMap = new Map<string, ReviewEntity>(
          twoStep.entities.map((e) => [e.key, e]),
        );
        const { transactions: initTxns, valuations: initVals } =
          recomputeTransactionsAndValuations(
            twoStep.transactions,
            twoStep.valuations,
            entityMap,
          );

        setEntities(twoStep.entities);
        setTransactions(initTxns);
        setValuations(initVals);
        setReconciliations(twoStep.reconciliation);

        // Set default selected entity in Step 1
        const firstAsset = twoStep.entities.find((e) => e.tab === "asset");
        const initialTab: EntityTabKind = firstAsset ? "asset" : (twoStep.entities[0]?.tab ?? "asset");
        setActiveEntityTab(initialTab);
        setSelectedEntityKey(firstAsset?.key ?? twoStep.entities[0]?.key ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileId, open]);

  // Recompute transaction/valuation block statuses whenever entity staging changes
  const refreshBlockedStatuses = useCallback(
    (currentEntities: ReviewEntity[]) => {
      const entityMap = new Map<string, ReviewEntity>(
        currentEntities.map((e) => [e.key, e]),
      );

      setTransactions((prevTxns) => {
        const { transactions: nextTxns } = recomputeTransactionsAndValuations(
          prevTxns,
          valuations,
          entityMap,
        );
        return nextTxns;
      });

      setValuations((prevVals) => {
        const { valuations: nextVals } = recomputeTransactionsAndValuations(
          transactions,
          prevVals,
          entityMap,
        );
        return nextVals;
      });
    },
    [transactions, valuations],
  );

  // Step 1: Toggle staging for a single entity
  function handleToggleStaged(key: string, staged: boolean) {
    setEntities((prev) => {
      const updated = prev.map((e) => (e.key === key ? { ...e, isStaged: staged } : e));
      refreshBlockedStatuses(updated);
      return updated;
    });
  }

  // Step 1: Toggle all new entities in current tab
  function handleToggleAllInTab(tab: EntityTabKind, staged: boolean) {
    setEntities((prev) => {
      const updated = prev.map((e) =>
        e.tab === tab && e.status === "new" ? { ...e, isStaged: staged } : e,
      );
      refreshBlockedStatuses(updated);
      return updated;
    });
  }

  // Step 1: Save remapped entity match
  function handleSaveRemap(
    entityKey: string,
    remapped: { id: string | null; name: string; isNew: boolean },
  ) {
    setEntities((prev) => {
      const updated = prev.map((e) => {
        if (e.key === entityKey) {
          return {
            ...e,
            name: remapped.name,
            status: (remapped.isNew ? "new" : "matched") as "new" | "matched",
            matchedId: remapped.id,
            isRemapped: true,
            remappedTo: remapped,
          };
        }
        return e;
      });
      refreshBlockedStatuses(updated);
      return updated;
    });
  }

  // Step 2: Toggle transaction selection (respects user manual selection)
  function handleToggleSelectTxn(id: string, selected: boolean) {
    setTransactions((prev) =>
      prev.map((t) => (t.id === id && t.status === "actionable" ? { ...t, selected } : t)),
    );
  }

  // Step 2: Toggle valuation selection
  function handleToggleSelectVal(id: string, selected: boolean) {
    setValuations((prev) =>
      prev.map((v) => (v.id === id && v.status === "actionable" ? { ...v, selected } : v)),
    );
  }

  // Step 2: Toggle all actionable transactions
  function handleToggleAllTxns(selected: boolean) {
    setTransactions((prev) =>
      prev.map((t) => (t.status === "actionable" ? { ...t, selected } : t)),
    );
  }

  // Step 2: Toggle all actionable valuations
  function handleToggleAllVals(selected: boolean) {
    setValuations((prev) =>
      prev.map((v) => (v.status === "actionable" ? { ...v, selected } : v)),
    );
  }

  // Step 2: In-cell edit transaction field with live resolution validation and state transitions
  function handleUpdateTxn(id: string, updates: Partial<ReviewTransaction>) {
    const entityMap = new Map<string, ReviewEntity>(entities.map((e) => [e.key, e]));
    setTransactions((prev) =>
      prev.map((t) => (t.id === id ? applyTransactionUpdate(t, updates, entityMap) : t)),
    );
  }

  // Step 2: In-cell edit valuation field
  function handleUpdateValuation(id: string, updates: Partial<ReviewValuation>) {
    setValuations((prev) =>
      prev.map((v) => (v.id === id ? { ...v, ...updates } : v)),
    );
  }

  // Step 2: Submit final approval using canonical DTO
  async function handleApprove() {
    if (!data) return;
    setApproving(true);

    try {
      const payload = buildApprovePayload({
        entities,
        transactions,
        valuations,
      });

      const res = await fetch(`/api/smart-files/${fileId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to approve fund update");

      const result = json.data?.fund_update;
      if (result) {
        const feedback = formatApprovalFeedback(result);
        if (feedback.type === "warning") {
          toast.warning(
            feedback.warningDetail
              ? `${feedback.message}: ${feedback.warningDetail}`
              : feedback.message,
          );
        } else {
          toast.success(feedback.message);
          if (feedback.warningDetail) {
            toast.warning(feedback.warningDetail);
          }
        }
      } else {
        toast.success("Fund update approved");
      }

      onApproved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApproving(false);
    }
  }

  // Options for From/To and Source of Fund selects
  const entityOptions: ReviewOption[] = useMemo(
    () => getEntityOptions(entities, "all"),
    [entities],
  );

  const sourceOptions: ReviewOption[] = useMemo(
    () => getEntityOptions(entities, "source"),
    [entities],
  );

  // Counters for footer
  const newEntities = useMemo(
    () => entities.filter((e) => e.status === "new"),
    [entities],
  );
  const stagedNewEntitiesCount = useMemo(
    () => newEntities.filter((e) => e.isStaged).length,
    [newEntities],
  );

  const selectedTxnsCount = useMemo(
    () => transactions.filter((t) => t.status === "actionable" && t.selected).length,
    [transactions],
  );

  const selectedValsCount = useMemo(
    () => valuations.filter((v) => v.status === "actionable" && v.selected).length,
    [valuations],
  );

  const duplicateRowsCount = useMemo(
    () =>
      transactions.filter((t) => t.status === "duplicate").length +
      valuations.filter((v) => v.status === "duplicate").length,
    [transactions, valuations],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "flex h-[92vh] max-h-[96vh] flex-col gap-0 overflow-hidden rounded-xl border border-border p-0 shadow-2xl",
          step === 2
            ? "w-[calc(100vw-2rem)] max-w-none"
            : "w-[95vw] max-w-6xl",
        )}
      >
        <DialogTitle className="sr-only">
          {data?.file.file_name ? `Review fund update: ${data.file.file_name}` : "Review fund update"}
        </DialogTitle>
        {loading ? (
          <div className="flex flex-1 items-center justify-center py-24">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-destructive">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : data ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Wizard Header */}
            <StepHeader
              step={step}
              fileName={data.file.file_name}
              fileStatus={data.file.processing_status}
              readOnly={isReadOnly}
              templateId={data.template_id}
              onStepClick={(targetStep) => setStep(targetStep)}
            />

            {/* Wizard Body: Step 1 vs Step 2 */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {step === 1 ? (
                <Step1Entities
                  entities={entities}
                  activeTab={activeEntityTab}
                  onTabChange={(tab) => {
                    setActiveEntityTab(tab);
                    const firstInTab = entities.find((e) => e.tab === tab);
                    setSelectedEntityKey(firstInTab?.key ?? null);
                  }}
                  selectedEntityKey={selectedEntityKey}
                  onSelectEntity={setSelectedEntityKey}
                  onToggleStaged={handleToggleStaged}
                  onToggleAllInTab={handleToggleAllInTab}
                  onSaveRemap={handleSaveRemap}
                  readOnly={isReadOnly}
                />
              ) : (
                <Step2LedgerRows
                  transactions={transactions}
                  valuations={valuations}
                  reconciliations={reconciliations}
                  entityOptions={entityOptions}
                  sourceOptions={sourceOptions}
                  stagedEntityCount={stagedNewEntitiesCount}
                  onToggleSelectTxn={handleToggleSelectTxn}
                  onToggleSelectVal={handleToggleSelectVal}
                  onToggleAllTxns={handleToggleAllTxns}
                  onToggleAllVals={handleToggleAllVals}
                  onUpdateTxn={handleUpdateTxn}
                  onUpdateValuation={handleUpdateValuation}
                  readOnly={isReadOnly}
                />
              )}
            </div>

            {/* Wizard Footer */}
            <StepFooter
              step={step}
              stagedNewEntitiesCount={stagedNewEntitiesCount}
              totalNewEntitiesCount={newEntities.length}
              selectedTxnsCount={selectedTxnsCount}
              selectedValsCount={selectedValsCount}
              duplicateRowsCount={duplicateRowsCount}
              approving={approving}
              readOnly={isReadOnly}
              onNextStep={() => setStep(2)}
              onPrevStep={() => setStep(1)}
              onApprove={handleApprove}
              onCancel={onClose}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
