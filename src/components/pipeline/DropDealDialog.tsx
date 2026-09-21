"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { dropDeal } from "@/lib/api/pipeline";

interface DropDealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  companyName: string;
  currentStage?: string | null;
  /** Called after a successful drop with the trimmed reason (or null when
   * left blank), so the caller can reflect the new status without waiting on
   * a refetch. */
  onSuccess: (reason: string | null) => void;
}

/** Reusable "drop deal" confirmation, shared by every place a deal can be
 * dropped outside the pipeline board (company details, master data). Mirrors
 * the pipeline board's own drop flow, minus the resurface scheduler, which is
 * board-specific. */
export default function DropDealDialog({
  open,
  onOpenChange,
  dealId,
  companyName,
  currentStage,
  onSuccess,
}: DropDealDialogProps) {
  const [reason, setReason] = useState("");
  const [isDropping, setIsDropping] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (isDropping) return;
    if (!next) setReason("");
    onOpenChange(next);
  };

  const handleDrop = async () => {
    setIsDropping(true);
    try {
      const trimmedReason = reason.trim() || null;
      await dropDeal(dealId, {
        currentStage: currentStage ?? undefined,
        reason: trimmedReason ?? undefined,
      });
      toast.success(`Dropped ${companyName}`);
      setReason("");
      onOpenChange(false);
      onSuccess(trimmedReason);
    } catch (err: unknown) {
      console.error("Error dropping deal:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Failed to drop deal: ${message}`);
    } finally {
      setIsDropping(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Drop deal?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to drop{" "}
            <span className="font-medium">{companyName}</span>? This will
            remove the deal from the pipeline.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-2">
          <Label htmlFor="drop-deal-reason">Reason (optional)</Label>
          <Textarea
            id="drop-deal-reason"
            data-testid="drop-deal-reason-input"
            placeholder="Why is this deal being dropped?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="mt-1.5"
            disabled={isDropping}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="drop-deal-cancel-button"
            disabled={isDropping}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="drop-deal-confirm-button"
            disabled={isDropping}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              handleDrop();
            }}
          >
            {isDropping ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Dropping...
              </>
            ) : (
              "Drop deal"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
