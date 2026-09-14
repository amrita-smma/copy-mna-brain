'use client';

import { NumericInput } from '@/components/common/NumericInput';
import { Label } from '@/components/ui/label';
import { flAbs, flDiv, flIsZero } from '@/lib/services/flDecimal';
import { cn } from '@/lib/utils';
import { FIELD_HINT, FIELD_INPUT, FIELD_LABEL } from './parts';

/** A blank price follows cash and units without saving a rounded derived value. */
export function PricePerUnitField({
  id, value, units, cash, currency, disabled, onChange,
}: {
  id: string;
  value: string;
  units: string;
  cash: string;
  currency: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  let calculated: string | null = null;
  try {
    if (!flIsZero(units) && !flIsZero(cash)) {
      calculated = flAbs(flDiv(cash, units));
    }
  } catch {
    // Inputs may be incomplete while the user is typing.
  }

  return (
    <div className="min-w-0">
      <Label htmlFor={id} className={FIELD_LABEL}>Price per share/unit</Label>
      <NumericInput
        id={id}
        className={cn('mt-1', FIELD_INPUT, 'font-mono tabular-nums')}
        value={value}
        disabled={disabled}
        placeholder={calculated ?? 'Optional'}
        aria-describedby={`${id}-hint`}
        onChange={onChange}
      />
      <div id={`${id}-hint`} className={cn('mt-1', FIELD_HINT)}>
        {!value.trim() && calculated !== null
          ? `${currency} ${calculated} — calculated from cash ÷ units. Enter a price to override.`
          : `In ${currency} per share/unit. Optional; entering a price does not change cash.`}
      </div>
    </div>
  );
}
