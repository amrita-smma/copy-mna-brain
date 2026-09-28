'use client';

import { FileText, X } from 'lucide-react';

interface InsightTemplateChipProps {
  name: string;
  onRemove: () => void;
}

/**
 * Shows the insight template attached via the composer's `/insight-template`
 * popup, and lets the user take it back off. Visual twin of
 * `SelectedContextChips`' pill, but with independent data wiring — it reads
 * plain `insightTemplate` context state rather than `usePageContext()`/the
 * `page_context` transport field, which is a different data flow.
 */
export function InsightTemplateChip({ name, onRemove }: InsightTemplateChipProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted pl-2 pr-2 py-1 text-xs max-w-[220px]">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate max-w-[140px]" title={name}>
        {name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="shrink-0 rounded p-0.5 hover:bg-background ml-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
