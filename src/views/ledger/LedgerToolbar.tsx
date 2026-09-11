'use client';

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  ENTRY_TYPES,
  ENTRY_TYPE_KEYS,
  entryTypeLabel,
  type FlEntryType,
} from '@/lib/fundLedger';
import { LedgerDateRange, type LedgerRange } from './LedgerDateRange';

export type LedgerViewMode = 'entry' | 'position';

/** The row of controls above the sheet. */
export function LedgerToolbar({
  mode,
  onModeChange,
  range,
  today,
  onRangeChange,
  wrap,
  onWrapChange,
  onOpenRules,
  onPostEntry,
}: {
  mode: LedgerViewMode;
  onModeChange: (mode: LedgerViewMode) => void;
  range: LedgerRange;
  today: string;
  onRangeChange: (range: LedgerRange) => void;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
  onOpenRules: () => void;
  onPostEntry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-md border bg-background p-0.5">
        {(
          [
            ['entry', 'All entries'],
            ['position', 'By position'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={cn(
              'rounded px-2.5 py-1 text-xs transition-colors',
              mode === value ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <LedgerDateRange range={range} today={today} onApply={onRangeChange} />

      <Label
        className="flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-normal"
        title="Show the full contents of every cell instead of truncating"
      >
        <Checkbox
          checked={wrap}
          onCheckedChange={(checked) => onWrapChange(checked === true)}
          className="h-3.5 w-3.5"
        />
        Wrap text
      </Label>

      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onOpenRules}>
        Entry rules
      </Button>

      <Button size="sm" className="ml-auto h-8 gap-1 text-xs" onClick={onPostEntry}>
        <Plus className="h-3.5 w-3.5" />
        Post entry
      </Button>
    </div>
  );
}

/**
 * The type chips, counted against the current window, plus the flagged-rows
 * toggle. Only types that actually appear get a chip — an empty chip is a dead
 * end that costs a click to discover.
 */
export function TypeFilterBar({
  counts,
  active,
  onChange,
  onlyNeedsChecking,
  onToggleNeedsChecking,
}: {
  counts: Partial<Record<FlEntryType, number>>;
  active: FlEntryType | 'all';
  onChange: (type: FlEntryType | 'all') => void;
  onlyNeedsChecking: boolean;
  onToggleNeedsChecking: () => void;
}) {
  const chipBase = 'rounded border px-2 py-0.5 text-[11px] transition-colors';

  const chips: { key: FlEntryType | 'all'; label: string; count?: number }[] = [
    { key: 'all', label: 'All types' },
    ...ENTRY_TYPE_KEYS.filter((type) => counts[type]).map((type) => ({
      key: type,
      label: entryTypeLabel(type),
      count: counts[type],
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">Filter:</span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onChange(chip.key)}
          className={cn(
            chipBase,
            active === chip.key
              ? 'border-primary bg-primary text-primary-foreground'
              : 'bg-background hover:bg-muted',
          )}
        >
          {chip.label}
          {chip.count !== undefined && (
            // Dimmed only while inactive. White at 70% over the primary fill is
            // about 2:1 against it, which is unreadable at 11px.
            <span className={cn('ml-1', active !== chip.key && 'opacity-60')}>{chip.count}</span>
          )}
        </button>
      ))}
      <button
        type="button"
        onClick={onToggleNeedsChecking}
        className={cn(
          chipBase,
          'ml-auto',
          onlyNeedsChecking
            ? 'border-primary bg-primary text-primary-foreground'
            : 'bg-background hover:bg-muted',
        )}
      >
        Needs checking only
      </button>
    </div>
  );
}

/** Every entry type, for the posting form's type picker. */
export const ALL_ENTRY_TYPES = ENTRY_TYPE_KEYS.filter((key) => key !== 'cash_movement').map((key) => ({
  key,
  spec: ENTRY_TYPES[key],
}));
