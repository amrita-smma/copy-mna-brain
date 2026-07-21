'use client';

import { useMemo } from 'react';
import { CURRENCY_SYMBOL } from '@/lib/currency';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import { money as moneyRaw, money2 as money2Raw, moneyK as moneyKRaw, moneyFee as moneyFeeRaw } from './calc';

/**
 * Returns the Fund Management money formatters (`money`, `money2`, `moneyK`,
 * `moneyFee`) pre-bound to the workspace display currency's symbol. Components
 * replace `import { money, ... } from './calc'` with
 * `const { money, ... } = useFundMoney()` so every figure relabels to the
 * workspace currency (relabel only — no FX conversion).
 */
export function useFundMoney() {
  const currency = useWorkspaceCurrency();
  return useMemo(() => {
    const sym = CURRENCY_SYMBOL[currency];
    return {
      currency,
      money: (v: number) => moneyRaw(v, sym),
      money2: (v: number) => money2Raw(v, sym),
      moneyK: (v: number) => moneyKRaw(v, sym),
      moneyFee: (vM: number) => moneyFeeRaw(vM, sym),
    };
  }, [currency]);
}
