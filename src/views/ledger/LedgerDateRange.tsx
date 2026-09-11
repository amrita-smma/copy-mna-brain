'use client';

import { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { addDays, formatDateInput, formatDateShort, parseDateInput, toIsoDate } from '@/lib/fundLedger';
import { FIELD_LABEL, FIELD_TEXT } from './parts';

/** A named starting point, relative to today. */
interface Preset {
  key: string;
  label: string;
  /** How the button reads when this preset is active and To is still today. */
  short: string;
  from: (today: string) => string | null;
}

const PRESETS: Preset[] = [
  { key: 'ytd', label: 'Year-to-date', short: 'Year to date', from: (today) => `${today.slice(0, 4)}-01-01` },
  { key: 'mtd', label: 'Month-to-date', short: 'Month to date', from: (today) => `${today.slice(0, 7)}-01` },
  { key: 'd30', label: '30 days ago', short: 'Last 30 days', from: (today) => addDays(today, -30) },
  { key: 'd7', label: '7 days ago', short: 'Last 7 days', from: (today) => addDays(today, -7) },
  { key: 'all', label: 'Since inception', short: 'All time', from: () => null },
];

export interface LedgerRange {
  /** Start of the listed range, or `null` for since-inception. */
  from: string | null;
  /** The as-of date. */
  to: string;
  /** Which preset produced this range, or `'custom'`. */
  preset: string;
}

/** Parse an ISO date as local midnight so the calendar highlights the right day. */
function toDate(iso: string | null): Date | undefined {
  if (!iso) return undefined;
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

/** How the trigger button reads for the current range. */
export function describeRange(range: LedgerRange, today: string): string {
  const preset = PRESETS.find((candidate) => candidate.key === range.preset);
  if (preset) {
    return range.to === today ? preset.short : `${preset.short} to ${formatDateShort(range.to)}`;
  }
  return range.from
    ? `${formatDateShort(range.from)} – ${formatDateShort(range.to)}`
    : `All time to ${formatDateShort(range.to)}`;
}

/**
 * The date control, which sets two different things.
 *
 * **To** is the as-of date: balances, commitment and blended price always count
 * from inception up to it. **From** only narrows which rows are listed and
 * which cash flows the metrics total. The hint at the bottom of the popover
 * says as much, because the distinction is not guessable from the control.
 */
export function LedgerDateRange({
  range,
  today,
  onApply,
}: {
  range: LedgerRange;
  today: string;
  onApply: (range: LedgerRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LedgerRange>(range);
  const [fromText, setFromText] = useState(formatDateInput(range.from));
  const [toText, setToText] = useState(formatDateInput(range.to));

  // Re-seed the draft each time the popover opens, so cancelling and reopening
  // starts from what is actually applied rather than the abandoned edit.
  useEffect(() => {
    if (!open) return;
    setDraft(range);
    setFromText(formatDateInput(range.from));
    setToText(formatDateInput(range.to));
  }, [open, range]);

  const setDraftRange = (next: LedgerRange) => {
    setDraft(next);
    setFromText(formatDateInput(next.from));
    setToText(formatDateInput(next.to));
  };

  const handleSelect = (selected: DateRange | undefined) => {
    if (!selected?.from) return;
    const from = toIsoDate(selected.from);
    const to = selected.to ? toIsoDate(selected.to) : null;
    setDraftRange({ from, to: to ?? draft.to, preset: 'custom' });
  };

  const commitText = (which: 'from' | 'to') => () => {
    const raw = which === 'from' ? fromText : toText;
    const trimmed = raw.trim();

    if (trimmed === '') {
      // A blank From means since inception; a blank To has no meaning — the
      // as-of date is what every balance is counted to.
      if (which === 'from') setDraftRange({ ...draft, from: null, preset: 'custom' });
      else setToText(formatDateInput(draft.to));
      return;
    }

    const parsed = parseDateInput(trimmed);
    if (!parsed || parsed > today) {
      setFromText(formatDateInput(draft.from));
      setToText(formatDateInput(draft.to));
      return;
    }

    if (which === 'from') {
      setDraftRange({
        ...draft,
        from: parsed > draft.to ? draft.to : parsed,
        preset: 'custom',
      });
    } else {
      setDraftRange({
        from: draft.from && draft.from > parsed ? parsed : draft.from,
        to: parsed,
        preset: 'custom',
      });
    }
  };

  const apply = () => {
    onApply(draft);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <CalendarDays className="h-3.5 w-3.5" />
          {describeRange(range, today)}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Date range
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() =>
                  setDraftRange({ from: preset.from(today), to: today, preset: preset.key })
                }
                className={cn(
                  'rounded border px-2 py-1 text-[11px] transition-colors',
                  draft.preset === preset.key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'hover:bg-muted',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="ledger-range-from" className={FIELD_LABEL}>
                From
              </Label>
              <Input
                id="ledger-range-from"
                className={cn('mt-1 h-8', FIELD_TEXT)}
                value={fromText}
                placeholder="Inception"
                onChange={(event) => setFromText(event.target.value)}
                onBlur={commitText('from')}
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="ledger-range-to" className={FIELD_LABEL}>
                  To
                </Label>
                <button
                  type="button"
                  className="text-[10px] text-primary hover:underline"
                  onClick={() => setDraftRange({ ...draft, to: today, preset: 'custom' })}
                >
                  Today
                </button>
              </div>
              <Input
                id="ledger-range-to"
                className={cn('mt-1 h-8', FIELD_TEXT)}
                value={toText}
                placeholder="dd/mm/yyyy"
                onChange={(event) => setToText(event.target.value)}
                onBlur={commitText('to')}
              />
            </div>
          </div>
          <Calendar
            mode="range"
            defaultMonth={toDate(draft.to)}
            selected={{ from: toDate(draft.from), to: toDate(draft.to) }}
            onSelect={handleSelect}
            disabled={{ after: toDate(today)! }}
            className="p-0"
          />
        </div>
        <div className="border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <b className="font-semibold text-foreground">To</b> is the as-of date — balances always
          count from inception up to it. <b className="font-semibold text-foreground">From</b> only
          narrows which rows are listed.
        </div>
        <div className="flex justify-end gap-2 border-t px-3 py-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={apply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
