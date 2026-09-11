'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCompact, formatGrouped, parseCurrencyInput } from './calc';
import { CURRENCIES, CURRENCY_SYMBOL, normalizeCurrency, type Currency } from '@/lib/currency';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';

// Currency handling for Fund Management money fields. The component is
// unit-agnostic: it takes/returns a raw numeric `amount` (whatever unit the
// caller stores in) plus a `currency`, and callers that keep values in
// millions (adapters.ts `M`/`toM`/`fromM`) convert at the boundary.
//
// The currency primitives now live in `@/lib/currency` (shared with the server
// and the company/pipeline views); re-export them here so the many existing
// `import { ... } from './CurrencyInput'` call sites keep working.
export { CURRENCIES, CURRENCY_SYMBOL, normalizeCurrency, type Currency };

/** Compact display with currency symbol, e.g. `$2M` / `Rp2.5M`. */
export function formatMoneyDisplay(amount: number | null | undefined, currency: Currency): string {
  if (amount == null) return '—';
  return `${CURRENCY_SYMBOL[currency]}${formatCompact(amount)}`;
}

/**
 * A currency amount editor: a currency prefix dropdown plus a text field that
 * shows grouped commas while focused and compacts to `$2M` on blur/Enter.
 * `onCommit(amount, currency)` fires once, on commit.
 */
export function CurrencyInput({
  amount,
  currency,
  onCommit,
  showCurrency = true,
  currencyEditable = true,
  id,
  className,
  autoFocus = false,
  onBlurred,
}: {
  amount: number | null | undefined;
  currency: Currency;
  onCommit: (amount: number | null, currency: Currency) => void;
  showCurrency?: boolean;
  /** When false, the currency is shown as a static prefix (no dropdown) —
   * used for inline table cells where the row inherits the holding currency. */
  currencyEditable?: boolean;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  /** Called after a commit that originated from a blur (used by MoneyInlineEdit). */
  onBlurred?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Escape can blur the input after their key handler runs. Finish each
  // focus session only once so cancel never commits and Enter never commits
  // the same amount twice.
  const finishedRef = useRef(false);
  // Currency selection is locked to the workspace display currency: the
  // dropdown defaults to it and the other codes are shown disabled with a note.
  const wsCurrency = useWorkspaceCurrency();

  useLayoutEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  const displayValue = focused
    ? draft
    : amount == null
      ? ''
      : formatCompact(amount);

  const commit = (fromBlur: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const parsed = parseCurrencyInput(draft);
    setFocused(false);
    onCommit(parsed, currency);
    if (fromBlur) onBlurred?.();
  };

  return (
    <div className={cn('flex items-stretch', className)}>
      {showCurrency &&
        (currencyEditable ? (
          <Select value={wsCurrency} onValueChange={(v) => onCommit(amount ?? null, v as Currency)}>
            <SelectTrigger className="h-9 w-[68px] shrink-0 rounded-r-none border-r-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c} disabled={c !== wsCurrency}>
                  {c === wsCurrency ? c : `${c} (currency not selected in the workspace)`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="inline-flex h-9 shrink-0 items-center rounded-l-md border border-r-0 bg-muted/50 px-2 text-xs text-muted-foreground">
            {wsCurrency}
          </span>
        ))}
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        value={displayValue}
        placeholder="0"
        onFocus={() => {
          setDraft(amount == null ? '' : formatGrouped(amount));
          finishedRef.current = false;
          setFocused(true);
        }}
        onChange={(e) => {
          // Live grouping: parse the raw entry then re-group the integer part,
          // preserving a trailing decimal point / digits the user is typing.
          const parsed = parseCurrencyInput(e.target.value);
          if (parsed == null) {
            setDraft(e.target.value.replace(/[^\d.,\-kKmMbB]/g, ''));
          } else if (/\.\d*$/.test(e.target.value) || /[kKmMbB]$/.test(e.target.value.trim())) {
            // Mid-typing a decimal or suffix — don't reformat under the cursor.
            // Only a trailing decimal point suppresses re-grouping; a trailing
            // thousands comma must NOT (else `1000000` renders as `1,000000`).
            setDraft(e.target.value);
          } else {
            setDraft(formatGrouped(parsed));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(false);
            onBlurred?.();
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finishedRef.current = true;
            setFocused(false);
            onBlurred?.();
          }
        }}
        onBlur={() => commit(true)}
        className={cn(
          'h-9 w-full min-w-0 rounded-md border bg-background px-3 py-1 text-sm text-foreground outline-none focus:border-accent',
          showCurrency && 'rounded-l-none',
        )}
      />
    </div>
  );
}

/**
 * Click-to-edit money cell for tables — mirrors `InlineEdit`'s affordance
 * (from parts.tsx) but reveals a `CurrencyInput` on click and shows the
 * compact `$2M` display otherwise.
 */
export function MoneyInlineEdit({
  amount,
  currency,
  onCommit,
  align = 'left',
  display,
  showCurrency = true,
  currencyEditable = false,
  className,
}: {
  amount: number | null | undefined;
  currency: Currency;
  onCommit: (amount: number | null, currency: Currency) => void;
  align?: 'left' | 'right';
  display?: ReactNode;
  showCurrency?: boolean;
  currencyEditable?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <CurrencyInput
        amount={amount}
        currency={currency}
        showCurrency={showCurrency}
        currencyEditable={currencyEditable}
        autoFocus
        onCommit={onCommit}
        onBlurred={() => setEditing(false)}
        className={cn('inline-flex', align === 'right' && 'justify-end', className)}
      />
    );
  }

  const empty = amount == null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={cn(
        'group inline-flex max-w-full items-center gap-1 rounded px-1 -mx-1 text-left align-middle hover:bg-muted hover:ring-1 hover:ring-border',
        align === 'right' && 'justify-end text-right',
        empty && 'text-muted-foreground',
        className,
      )}
    >
      <span className="truncate">{display ?? formatMoneyDisplay(amount, currency)}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        ✎
      </span>
    </button>
  );
}
