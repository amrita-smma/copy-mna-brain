'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InsightFrame } from '@/components/insights/InsightFrame';
import { describeInsightDocument } from '@/lib/insights/editReview';

export interface ResolvedInsightDocumentProps {
  /** The document the card proposed, exactly as authored. */
  html: string;
  /** Accessible name for the frame, and the row's label. */
  title: string;
  className?: string;
}

/**
 * The document of a decided insight card, closed by default.
 *
 * An open card is where a change is judged, so its frame is always mounted.
 * A decided card is only read past — and every mounted `InsightFrame` is a
 * live sandboxed document, up to the insight size cap, held for as long as
 * the thread is on screen. A long thread with several approved edits used to
 * keep one per card. The frame now mounts only while the user has the row
 * open, and is torn down when they close it.
 */
export function ResolvedInsightDocument({ html, title, className }: ResolvedInsightDocumentProps) {
  const [open, setOpen] = useState(false);
  // Measured once per document, not on every scroll-driven re-render.
  const size = useMemo(() => describeInsightDocument(html), [html]);
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div
      className={cn('rounded-lg border border-border bg-card', className)}
      data-testid="resolved-insight-document"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-muted"
        data-testid="resolved-insight-document-toggle"
      >
        <span className="truncate font-medium text-foreground">{title}</span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {size}
          <span className="text-primary">{open ? 'Hide' : 'Show'}</span>
          <Chevron className="h-3.5 w-3.5" />
        </span>
      </button>
      {open && (
        <div className="max-h-96 min-w-0 overflow-x-auto overflow-y-auto border-t border-border p-1">
          <InsightFrame html={html} title={title} minHeight={250} maxHeight={500} />
        </div>
      )}
    </div>
  );
}
