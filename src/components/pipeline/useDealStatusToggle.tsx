"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useRestoreDeal } from "@/components/pipeline/useRestoreDeal";
import { companyDisplayName } from "@/lib/companyDisplay";

interface DealStatusCompany {
  id: string;
  target: string | null;
  project_name?: string | null;
  pipeline_stage: string | null;
  status?: string | null;
}

interface Options {
  company: DealStatusCompany | null;
  /** Dropping needs a reason, so it opens the host's `DropDealDialog`. */
  onDropRequested: () => void;
  /** Called after a restore, with the stage the deal was restored to (if moved). */
  onRestored: (stage: string | null) => void;
}

export interface DealStatusToggle {
  change: (next: "active" | "dropped") => Promise<void>;
  busy: boolean;
  /** The "restore to which stage?" prompt; render it once in the host. */
  restoreStageDialog: ReactNode;
}

/**
 * The Details tab's Deal Status (Active / Dropped) select. Dropping and
 * reactivating are immediate actions with their own log entry, not fields
 * saved with the Company Information form.
 */
export function useDealStatusToggle({ company, onDropRequested, onRestored }: Options): DealStatusToggle {
  const { restore, restoreStageDialog } = useRestoreDeal();
  const [busy, setBusy] = useState(false);

  const change = async (next: "active" | "dropped") => {
    if (!company || next === (company.status === "dropped" ? "dropped" : "active")) return;
    if (next === "dropped") {
      onDropRequested();
      return;
    }
    // Reactivating is immediate, no confirmation — matches the pipeline
    // board's restore action.
    setBusy(true);
    try {
      const { restored, stage } = await restore({
        id: company.id,
        name: companyDisplayName(company, "This deal"),
        currentStage: company.pipeline_stage,
      });
      if (!restored) return;
      toast.success(`Restored ${companyDisplayName(company, "company")}`);
      onRestored(stage ?? null);
    } catch (err: unknown) {
      console.error("Error restoring deal:", err);
      toast.error(`Failed to restore deal: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  return { change, busy, restoreStageDialog };
}
