'use client';

import {
  insightSectionRefId,
  formatInsightChildSteps,
  type InsightSectionRef,
} from '@/lib/chat/pageContext';
import {
  usePageContext,
  clearInsightSection,
  clearAllInsightSections,
} from '@/lib/chat/pageContextStore';
import { cn } from '@/lib/utils';
import { SquareDashedMousePointer, X } from 'lucide-react';

interface SelectedContextChipsProps {
  className?: string;
}

function formatChipTitle(ref: InsightSectionRef): string {
  const anchor = ref.key ?? 'body';
  const childSteps = formatInsightChildSteps(ref);
  return childSteps ? `Section: ${anchor} › ${childSteps}` : `Section: ${anchor}`;
}

/**
 * Shows which insight sections the next turn will carry, and lets the user
 * take them back off.
 *
 * The refs arrive already in document order — they are ordered inside the
 * insight frame, whose DOM is in an opaque origin this component cannot read.
 * Renders nothing when no sections are selected.
 */
export function SelectedContextChips({ className }: SelectedContextChipsProps) {
  const sections = usePageContext()?.insightSections ?? [];

  if (sections.length === 0) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {sections.map((ref) => {
        const id = insightSectionRefId(ref);
        const hasPath = ref.path && ref.path.length > 0;
        // A keyless pick has no name to show, so name what it actually is: the
        // element's tag, which is the last step of the path.
        const leafTag = ref.tags?.[ref.tags.length - 1];
        const label = ref.key
          ? hasPath
            ? `Section: ${ref.key} › …`
            : `Section: ${ref.key}`
          : `Element: <${leafTag ?? 'body'}>`;
        const title = formatChipTitle(ref);

        return (
          <div
            key={id}
            className="flex items-center gap-1.5 rounded-md border border-border bg-muted pl-2 pr-2 py-1 text-xs max-w-[220px]"
          >
            <SquareDashedMousePointer
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="truncate max-w-[140px]" title={title}>
              {label}
            </span>
            <button
              type="button"
              onClick={() => clearInsightSection(id)}
              aria-label={`Remove ${label}`}
              className="shrink-0 rounded p-0.5 hover:bg-background ml-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      {sections.length >= 2 && (
        <button
          type="button"
          onClick={clearAllInsightSections}
          className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
