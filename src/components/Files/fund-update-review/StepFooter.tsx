"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowRight, ArrowLeft } from "lucide-react";
import type { WizardStep } from "./types";

interface StepFooterProps {
  step: WizardStep;
  stagedNewEntitiesCount: number;
  totalNewEntitiesCount: number;
  selectedTxnsCount: number;
  selectedValsCount: number;
  duplicateRowsCount: number;
  approving: boolean;
  readOnly?: boolean;
  onNextStep: () => void;
  onPrevStep: () => void;
  onApprove: () => void;
  onCancel: () => void;
}

export function StepFooter({
  step,
  stagedNewEntitiesCount,
  totalNewEntitiesCount,
  selectedTxnsCount,
  selectedValsCount,
  duplicateRowsCount,
  approving,
  readOnly = false,
  onNextStep,
  onPrevStep,
  onApprove,
  onCancel,
}: StepFooterProps) {
  const totalSelectedRows = selectedTxnsCount + selectedValsCount;
  const canApprove = totalSelectedRows > 0 || stagedNewEntitiesCount > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-6 py-3">
      {/* Left side informational counter */}
      <div className="text-xs text-muted-foreground">
        {step === 1 ? (
          <span>
            <strong className="text-foreground">{stagedNewEntitiesCount}</strong> of{" "}
            <strong className="text-foreground">{totalNewEntitiesCount}</strong> new records staged
            · nothing written to database yet
          </span>
        ) : (
          <span>
            {duplicateRowsCount > 0 ? (
              <span>
                {duplicateRowsCount} row{duplicateRowsCount === 1 ? "" : "s"} already imported and
                will be skipped
              </span>
            ) : (
              <span>No duplicate ledger rows found · all valid rows staged for approval</span>
            )}
          </span>
        )}
      </div>

      {/* Right side navigation buttons */}
      <div className="flex items-center gap-2">
        {step === 1 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onNextStep}
              className="h-8 text-xs gap-1.5"
            >
              <span>Continue to ledger rows</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPrevStep}
              disabled={approving}
              className="h-8 text-xs gap-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to entities</span>
            </Button>

            {readOnly ? (
              <Button
                type="button"
                size="sm"
                onClick={onCancel}
                className="h-8 text-xs"
              >
                Close
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={onApprove}
                disabled={approving || !canApprove}
                className="h-8 text-xs"
              >
                {approving ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Applying…
                  </>
                ) : (
                  `Approve ${stagedNewEntitiesCount} record${stagedNewEntitiesCount === 1 ? "" : "s"} and ${totalSelectedRows} row${totalSelectedRows === 1 ? "" : "s"}`
                )}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
