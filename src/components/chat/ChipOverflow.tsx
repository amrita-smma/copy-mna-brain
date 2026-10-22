'use client';

import { Children, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/** How many chips a row shows on mobile before the rest fold away. */
export const MOBILE_CHIP_LIMIT = 3;

/** Pure layout for tests: how many chips to show and whether the toggle appears. */
export function chipOverflowLayout(
  isMobile: boolean,
  chipCount: number,
  expanded: boolean,
): { collapsible: boolean; shownCount: number; hiddenCount: number } {
  const collapsible = isMobile && chipCount > MOBILE_CHIP_LIMIT;
  const shownCount = collapsible && !expanded ? MOBILE_CHIP_LIMIT : chipCount;
  const hiddenCount = Math.max(0, chipCount - MOBILE_CHIP_LIMIT);
  return { collapsible, shownCount, hiddenCount };
}

/**
 * A wrapping row of chips under a chat answer ("Open <company>", sources,
 * files). On mobile a long row buries the answer, so past
 * `MOBILE_CHIP_LIMIT` chips the rest fold behind a "+N more" chip that
 * expands them in place. Desktop always shows every chip.
 */
export function ChipOverflow({ children, className }: { children: ReactNode; className?: string }) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const chips = Children.toArray(children);
  const { collapsible, shownCount, hiddenCount: hidden } = chipOverflowLayout(
    isMobile,
    chips.length,
    expanded,
  );
  const shown = chips.slice(0, shownCount);

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {shown}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Show fewer chips' : `Show ${hidden} more chips`}
          className="inline-flex items-center gap-1 rounded-lg border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors active:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          data-testid="chip-overflow-toggle"
        >
          {expanded ? 'Show less' : `+${hidden} more`}
          <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}
