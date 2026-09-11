'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  FILTER_COLUMN_LABELS,
  NUMERIC_OPERATOR_LABELS,
  isNumericColumn,
  isPartyColumn,
  type FilterColumn,
  type FilterOperator,
} from '@/lib/fundLedger';

/** Where the menu was opened and what was under the cursor. */
export interface CellFilterTarget {
  column: FilterColumn;
  /** The cell's text, or `''` for a numeric column with no text form. */
  value: string;
  /** What to show for a value that isn't readable — an id, typically. */
  display?: string;
  x: number;
  y: number;
}

interface MenuItem {
  column: FilterColumn;
  operator: FilterOperator;
  label: string;
  /** The part of the label to bold — the value being matched. */
  emphasis?: string;
  danger?: boolean;
}

function buildItems(target: CellFilterTarget): MenuItem[] {
  const label = FILTER_COLUMN_LABELS[target.column] ?? target.column;
  const shown = target.display ?? target.value;

  // A numeric column has no text to match on, so it offers sign tests instead.
  if (isNumericColumn(target.column)) {
    return (Object.keys(NUMERIC_OPERATOR_LABELS) as FilterOperator[]).map((operator) => ({
      column: target.column,
      operator,
      label: `${label} ${NUMERIC_OPERATOR_LABELS[operator]}`,
    }));
  }

  // Right-clicking a party is nearly always "show me everything touching this",
  // so the direction-specific options come first and "either way" sits with them.
  if (isPartyColumn(target.column)) {
    return [
      { column: 'from', operator: 'is', label: 'From', emphasis: shown },
      { column: 'to', operator: 'is', label: 'To', emphasis: shown },
      { column: target.column, operator: 'involves', label: 'Involves', emphasis: shown },
      { column: target.column, operator: 'includes', label: `${label} includes`, emphasis: shown },
      { column: target.column, operator: 'not', label: 'Not', emphasis: shown },
    ];
  }

  return [
    { column: target.column, operator: 'is', label: `${label} is`, emphasis: shown },
    { column: target.column, operator: 'includes', label: `${label} includes`, emphasis: shown },
    { column: target.column, operator: 'not', label: `${label} not`, emphasis: shown },
  ];
}

/**
 * The menu that opens on right-clicking a cell.
 *
 * Positioned by hand rather than through Radix: the trigger is a table cell
 * that may be one of several thousand, and wrapping each one in a context-menu
 * primitive costs far more than reading the pointer coordinates once.
 */
export function CellFilterMenu({
  target,
  filterCount,
  onAddFilter,
  onClearFilters,
  onClose,
}: {
  target: CellFilterTarget | null;
  filterCount: number;
  onAddFilter: (filter: {
    column: FilterColumn;
    operator: FilterOperator;
    value: string;
    display?: string;
  }) => void;
  onClearFilters: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Measure after mount so the menu can be nudged back on screen when opened
  // near the right or bottom edge.
  useLayoutEffect(() => {
    if (!target || !ref.current) {
      setPosition(null);
      return;
    }
    const { offsetWidth, offsetHeight } = ref.current;
    setPosition({
      left: Math.max(8, Math.min(target.x, window.innerWidth - offsetWidth - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - offsetHeight - 8)),
    });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture-phase scroll so the menu closes when any ancestor scrolls, not
    // only the window.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [target, onClose]);

  if (!target) return null;

  const items = buildItems(target);

  return (
    <>
      {/* Catches the click that dismisses the menu, including a right-click
          elsewhere in the sheet. */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        className="fixed z-50 min-w-[220px] overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        style={{
          left: position?.left ?? target.x,
          top: position?.top ?? target.y,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        <div className="border-b px-2.5 pb-1.5 pt-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {FILTER_COLUMN_LABELS[target.column] ?? target.column}
          </div>
          {(target.display ?? target.value) && (
            <div className="truncate text-[11px] font-medium">
              {target.display ?? target.value}
            </div>
          )}
        </div>
        {items.map((item, itemIndex) => (
          <button
            key={`${item.column}:${item.operator}:${itemIndex}`}
            type="button"
            role="menuitem"
            className="flex w-full items-center px-2.5 py-1.5 text-left text-[12px] hover:bg-muted"
            onClick={() => {
              onAddFilter({
                column: item.column,
                operator: item.operator,
                value: target.value,
                display: target.display,
              });
              onClose();
            }}
          >
            <span className="truncate">
              {item.label}
              {item.emphasis && <span className="ml-1 font-semibold">{item.emphasis}</span>}
            </span>
          </button>
        ))}
        {filterCount > 0 && (
          <>
            <div className="my-1 border-t" />
            <button
              type="button"
              role="menuitem"
              className={cn(
                'flex w-full px-2.5 py-1.5 text-left text-[12px] hover:bg-muted',
                'text-red-600 dark:text-red-400',
              )}
              onClick={() => {
                onClearFilters();
                onClose();
              }}
            >
              Clear all {filterCount} filter{filterCount > 1 ? 's' : ''}
            </button>
          </>
        )}
      </div>
    </>
  );
}
