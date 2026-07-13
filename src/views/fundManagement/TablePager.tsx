'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TablePagerProps {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Singular noun for the summary line, e.g. "asset" → "1–25 of 60 assets". */
  itemLabel: string;
}

/** Prev/Next pager with an "n–m of total" summary, shared by the paginated
 *  portfolio tables. Renders nothing when everything fits on one page. */
export function TablePager({ page, pageSize, total, onPageChange, itemLabel }: TablePagerProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, total);

  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <span className="text-[11px] text-muted-foreground">
        {total === 0
          ? `No ${itemLabel}s`
          : `${start}–${end} of ${total} ${itemLabel}${total === 1 ? '' : 's'}`}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            disabled={current <= 1}
            onClick={() => onPageChange(current - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Page {current} of {pageCount}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            disabled={current >= pageCount}
            onClick={() => onPageChange(current + 1)}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
