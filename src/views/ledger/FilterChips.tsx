'use client';

import { X } from 'lucide-react';
import { describeFilter, type LedgerFilter } from '@/lib/fundLedger';

/**
 * The active quick filters, each removable.
 *
 * These narrow what is listed and what the cash-flow metrics total — never the
 * as-of balances, which is why removing one changes the sheet but not what a
 * position is worth.
 */
export function FilterChips({
  filters,
  onRemove,
  onClear,
}: {
  filters: LedgerFilter[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">Filters:</span>
      {filters.map((filter) => {
        const { prefix, value } = describeFilter(filter);
        return (
          <span
            key={filter.id}
            className="inline-flex max-w-[280px] items-center gap-1 rounded border bg-background py-0.5 pl-2 pr-1 text-[11px]"
          >
            <span className="truncate">
              {prefix}
              {value && <span className="ml-1 font-semibold">{value}</span>}
            </span>
            <button
              type="button"
              aria-label={`Remove filter: ${prefix} ${value}`.trim()}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onRemove(filter.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="rounded border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
        onClick={onClear}
      >
        Clear all
      </button>
    </div>
  );
}
