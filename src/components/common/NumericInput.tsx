'use client';

import { forwardRef, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { groupNumericText, regroupNumericInput } from '@/lib/numberFormat';

export interface NumericInputProps
  extends Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> {
  /** The value, ungrouped. Separators in it are ignored, so a caller may hand
   * back either form. */
  value: string;
  /** Fires with the ungrouped text — never with the commas shown on screen. */
  onChange: (value: string) => void;
  /** Accept a trailing `k`/`m`/`b` multiplier, for fields whose commit path
   * expands it (see `parseCurrencyInput`). Off by default: an exact decimal
   * field has no use for one. */
  allowSuffix?: boolean;
}

/**
 * A number field that groups thousands as you type.
 *
 * The value is carried as a string end to end, so an exact `numeric(38,8)`
 * decimal survives being edited — routing it through a `number` to format it
 * would round away digits the ledger stores. Grouping is display-only: what the
 * caller receives is always ungrouped, and text this cannot read as a number is
 * passed through untouched for the caller's own validation to refuse.
 *
 * Re-grouping mid-word moves every character after the edit, so the caret is
 * restored from a count of ungrouped characters rather than left to fall to the
 * end of the field.
 */
export const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(
  function NumericInput({ value, onChange, allowSuffix = false, ...rest }, forwardedRef) {
    const innerRef = useRef<HTMLInputElement | null>(null);
    const pendingCaret = useRef<number | null>(null);

    // After the parent has re-rendered with the regrouped value — the point at
    // which the browser has moved the caret to the end of the field.
    useLayoutEffect(() => {
      const element = innerRef.current;
      const caret = pendingCaret.current;
      pendingCaret.current = null;
      if (element && caret != null && document.activeElement === element) {
        element.setSelectionRange(caret, caret);
      }
    });

    return (
      <Input
        {...rest}
        ref={(node) => {
          innerRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        type="text"
        inputMode="decimal"
        value={groupNumericText(value, { allowSuffix })}
        onChange={(event) => {
          const target = event.target;
          const next = regroupNumericInput(
            target.value,
            target.selectionStart ?? target.value.length,
            { allowSuffix },
          );
          pendingCaret.current = next.caret;
          onChange(next.value);
        }}
      />
    );
  },
);
