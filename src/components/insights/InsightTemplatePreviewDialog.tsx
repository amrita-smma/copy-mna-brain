'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InsightFrame } from './InsightFrame';
import { AlertTriangle, Loader2 } from 'lucide-react';

/** What the preview shows. `key` changes whenever the document does. */
export interface TemplatePreviewTarget {
  key: string;
  title: string;
  subtitle?: string;
  fetchHtml: () => Promise<string>;
  /** Shown as "Use Template" when set; omitted for an old version's preview. */
  onUseTemplate?: () => void;
}

export interface InsightTemplatePreviewDialogProps {
  target: TemplatePreviewTarget | null;
  onClose: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; html: string }
  | { status: 'error' };

/**
 * A template (or one of its versions) rendered full size in an
 * `InsightFrame`, the same sandboxed frame the insight history preview uses.
 */
export function InsightTemplatePreviewDialog({
  target,
  onClose,
}: InsightTemplatePreviewDialogProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setState({ status: 'loading' });
    target
      .fetchHtml()
      .then((html) => {
        if (!cancelled) setState({ status: 'ready', html });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // Refetch per document, not per render of the caller's closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="bg-card text-card-foreground border border-border sm:max-w-5xl h-[85vh] flex flex-col p-6 shadow-lg"
        data-testid="insight-template-preview-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{target?.title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {target?.subtitle ?? 'Template preview'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto border border-border rounded-lg bg-card">
          {state.status === 'ready' && target ? (
            <InsightFrame html={state.html} title={`Preview: ${target.title}`} minHeight={300} />
          ) : state.status === 'error' ? (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-1.5 text-muted-foreground">
              <AlertTriangle className="h-5 w-5" />
              <span className="text-sm">Preview unavailable</span>
            </div>
          ) : (
            <div className="flex h-full min-h-[300px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="bg-card text-foreground border-border hover:bg-muted"
          >
            Close
          </Button>
          {target?.onUseTemplate && (
            <Button
              type="button"
              onClick={() => {
                target.onUseTemplate?.();
                onClose();
              }}
              className="bg-primary text-primary-foreground hover:bg-primary"
            >
              Use Template
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
