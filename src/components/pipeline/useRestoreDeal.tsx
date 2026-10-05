"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { restoreDeal } from "@/lib/api/pipeline";
import { usePipelineStages } from "@/hooks/usePipelineStages";

interface RestoreRequest {
  id: string;
  name: string;
  currentStage: string | null | undefined;
}

/** `restored` is false when the user cancelled; `stage` is where the deal now sits. */
export interface RestoreResult {
  restored: boolean;
  stage: string | null | undefined;
}

interface PendingRestore extends RestoreRequest {
  resolve: (result: RestoreResult) => void;
}

/**
 * Restore a dropped deal (MB-651). When its stage was deleted while it was
 * dropped, the server answers `restore_stage_required`; this asks the user
 * which stage to restore it into and retries. `restore` resolves once the deal
 * is restored (with the stage it landed in) or the user cancels; other errors
 * reject as before. Render `restoreStageDialog` once in the calling view.
 */
export function useRestoreDeal(): {
  restore: (request: RestoreRequest) => Promise<RestoreResult>;
  restoreStageDialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const pendingRef = useRef<PendingRestore | null>(null);

  const restore = useCallback(async (request: RestoreRequest): Promise<RestoreResult> => {
    try {
      await restoreDeal(request.id, { currentStage: request.currentStage });
      return { restored: true, stage: request.currentStage };
    } catch (err) {
      if ((err as { code?: string }).code !== "restore_stage_required") throw err;
      return new Promise<RestoreResult>((resolve) => {
        const next = { ...request, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    }
  }, []);

  const close = (result: RestoreResult) => {
    pendingRef.current?.resolve(result);
    pendingRef.current = null;
    setPending(null);
  };

  const restoreStageDialog = pending ? (
    <RestoreStageDialog key={pending.id} request={pending} onClose={close} />
  ) : null;

  return { restore, restoreStageDialog };
}

function RestoreStageDialog({
  request,
  onClose,
}: {
  request: PendingRestore;
  onClose: (result: RestoreResult) => void;
}) {
  const { live, label } = usePipelineStages();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await restoreDeal(request.id, { currentStage: request.currentStage, targetStage: target });
      onClose({ restored: true, stage: target });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore deal");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose({ restored: false, stage: request.currentStage });
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose a stage to restore to</DialogTitle>
          <DialogDescription>
            {request.name} was dropped at {request.currentStage ? label(request.currentStage) : "a stage"},
            which has since been deleted. Pick the stage it should go back into.
          </DialogDescription>
        </DialogHeader>
        <Select value={target} onValueChange={setTarget} disabled={busy}>
          <SelectTrigger aria-label="Stage to restore to">
            <SelectValue placeholder="Select a stage…" />
          </SelectTrigger>
          <SelectContent>
            {live.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {label(s.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onClose({ restored: false, stage: request.currentStage })} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirm()} disabled={busy || !target}>
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
