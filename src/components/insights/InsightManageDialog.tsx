'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { renameInsight, archiveInsight, deleteInsightPermanently } from '@/lib/api/insights';
import { Loader2, AlertCircle, Pencil, Archive, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

export interface InsightManageDialogProps {
  insightId: string;
  insightName: string;
  mode: 'rename' | 'archive' | 'delete';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

const COPY = {
  rename: {
    success: 'Insight renamed',
    logError: 'Failed to rename insight',
    fallbackError: 'Failed to rename insight. Please try again.',
    inProgress: 'Saving...',
    action: 'Save',
  },
  archive: {
    success: 'Insight archived',
    logError: 'Failed to archive insight',
    fallbackError: 'Failed to archive insight. Please try again.',
    inProgress: 'Archiving...',
    action: 'Archive',
  },
  delete: {
    success: 'Insight deleted',
    logError: 'Failed to delete insight',
    fallbackError: 'Failed to delete insight. Please try again.',
    inProgress: 'Deleting...',
    action: 'Delete',
  },
} as const;

export function InsightManageDialog({
  insightId,
  insightName,
  mode,
  open,
  onOpenChange,
  onDone,
}: InsightManageDialogProps) {
  const [name, setName] = useState(insightName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const unchanged = trimmed === insightName.trim();
  const isRenameDisabled = submitting || !trimmed || unchanged;

  useEffect(() => {
    if (open) {
      setName(insightName);
      setError(null);
      setSubmitting(false);
    }
  }, [open, insightName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (mode === 'rename' && (!trimmed || unchanged)) return;

    setSubmitting(true);
    setError(null);

    const copy = COPY[mode];
    try {
      if (mode === 'rename') {
        await renameInsight(insightId, trimmed);
      } else if (mode === 'archive') {
        await archiveInsight(insightId);
      } else {
        await deleteInsightPermanently(insightId);
      }
      toast.success(copy.success);
      onOpenChange(false);
      onDone?.();
    } catch (err: unknown) {
      console.error(copy.logError, err);
      setError(
        err instanceof Error
          ? err.message
          : copy.fallbackError,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (submitting) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="bg-card text-card-foreground border border-border sm:max-w-lg p-6 shadow-lg"
        onPointerDownOutside={(e) => {
          if (submitting) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            {mode === 'rename' ? (
              <Pencil className="h-5 w-5 text-primary" />
            ) : mode === 'archive' ? (
              <Archive className="h-5 w-5 text-destructive" />
            ) : (
              <Trash2 className="h-5 w-5 text-destructive" />
            )}
            <DialogTitle className="text-xl font-semibold">
              {mode === 'rename'
                ? 'Rename Insight'
                : mode === 'archive'
                ? 'Archive Insight'
                : 'Delete this insight?'}
            </DialogTitle>
          </div>
          <DialogDescription className="text-muted-foreground text-sm">
            {mode === 'rename'
              ? 'Enter a new name for this insight.'
              : mode === 'archive'
              ? 'Archiving hides it from the insight list. Published versions are kept.'
              : "This action can't be undone."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {error && (
            <div className="p-3 rounded-lg border border-destructive bg-card text-destructive flex items-start gap-2.5 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="flex-1 leading-normal text-xs sm:text-sm">{error}</div>
            </div>
          )}

          {mode === 'rename' ? (
            <div className="space-y-2">
              <Label
                htmlFor="rename-insight-name"
                className="text-sm font-medium text-foreground"
              >
                Insight Name
              </Label>
              <Input
                id="rename-insight-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Portfolio Executive Summary"
                disabled={submitting}
                className="bg-card text-foreground border border-input"
                autoFocus
              />
            </div>
          ) : mode === 'archive' ? (
            <div className="p-4 rounded-lg bg-muted border border-border text-foreground space-y-2">
              <p className="text-sm font-medium">
                Are you sure you want to archive &ldquo;
                <span className="font-semibold text-foreground">{insightName}</span>
                &rdquo;?
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Archiving hides this insight from the insight list. All published versions are kept.
              </p>
            </div>
          ) : (
            <div className="p-4 rounded-lg bg-muted border border-border text-foreground space-y-2">
              <p className="text-sm font-medium">
                Are you sure you want to delete &ldquo;
                <span className="font-semibold text-foreground">{insightName}</span>
                &rdquo;?
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                This action can&apos;t be undone.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={mode === 'rename' ? 'default' : 'destructive'}
              disabled={mode === 'rename' ? isRenameDisabled : submitting}
              className={
                mode === 'rename'
                  ? 'bg-primary text-primary-foreground hover:bg-primary'
                  : 'bg-destructive text-destructive-foreground hover:bg-destructive'
              }
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {COPY[mode].inProgress}
                </>
              ) : (
                COPY[mode].action
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
