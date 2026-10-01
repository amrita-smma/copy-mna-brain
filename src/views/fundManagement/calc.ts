// Pure calculation + formatting helpers for Fund Management, ported from the
// mockup so the numbers match exactly. No DOM, no side effects.

import type {
  AssetHolderIdentity,
  EquityMetrics,
  FoFMetrics,
  Fund,
  Holding,
  Inv,
  Investor,
  IrrResult,
  Quarter,
  Txn,
  TxnType,
  ValuationCoverage,
} from './types';
export type { AssetHolderIdentity };
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  type SellProceedsDestination,
} from '@/lib/sellProceedsDestination';
import { flIsZero } from '@/lib/services/flDecimal';
import { distinctEnglishName } from '@/lib/fundLedger/format';
import { formatCompact } from '@/lib/numberFormat';
import { quarterEndLabel, toDisplayMillions, trailingQuarterEnds } from './adapters';

// The 4 trailing completed quarters as of "now" — real labels for real
// fund.hist data (computeFundHistory), not the mockup's 4 hardcoded strings.
export const QLABELS = trailingQuarterEnds(4).map(quarterEndLabel);
export const INVEST_TYPES = ['Direct Investment', 'Fund of Funds', 'Others'];

// ---- number formatting ----
// These now live in `@/lib/numberFormat` so the ledger form — and anything
// added later — groups and parses numbers exactly the way the fund tables do.
// Re-exported here because every Fund Management file imports them from
// `./calc`.
export {
  applyCommas,
  formatCompact,
  formatGrouped,
  groupNumericText,
  parseCurrencyInput,
  regroupNumericInput,
  stripCommas,
} from '@/lib/numberFormat';

// ---- money formatting ----
// Domain money values are in MILLIONS (see adapters.ts `toM`/`fromM`). All
// amount formatters render compactly from the underlying dollars so large
// figures read as `$20B`, not `$20000.3M`, and stay consistent across tabs.
// The `sym` prefix defaults to '$' so any caller/test that doesn't pass a
// currency is unaffected. Fund components pass the workspace currency symbol
// via the `useFundMoney()` hook so all displays follow the workspace setting.
export const money = (v: number, sym = '$') => sym + formatCompact((v || 0) * 1e6);
export const money2 = (v: number, sym = '$') => sym + v.toFixed(2);
// Fund-of-funds amounts are also stored in millions — same compact treatment
// (previously multiplied by 1000, which mis-scaled the display by 1000×).
export const moneyK = (v: number, sym = '$') => sym + formatCompact((v || 0) * 1e6);
export const moneyFee = (vM: number, sym = '$') => sym + formatCompact(Math.abs((vM || 0) * 1e6));

// ---- name helpers ----
/** The label to show for an asset: its recorded (possibly non-English) name,
 * with the English name in brackets when one is set — `株式会社ABC (ABC Corp)`.
 * Falls back to the plain name when there's no English name, or when it just
 * repeats the recorded one. */
export function getAssetDisplayName(h: Holding): string {
  const name = h.n ?? '';
  const en = distinctEnglishName(name, h.englishName);
  return en ? `${name} (${en})` : name;
}

/**
 * Normalises an entity name for lookup: trimmed, lowercased, and internal whitespace collapsed.
 */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Builds a lookup map from entity name forms (raw and normalised) to parent group name.
 * Maps investor.n, englishName, legalName, id, and groupName itself to groupName.
 */
export function buildInvestorGroupLookup(
  investors?: Investor[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const inv of investors ?? []) {
    const group = inv.groupName ?? null;
    const names = [inv.n, inv.englishName, inv.legalName].filter(
      (n): n is string => Boolean(n && n.trim()),
    );
    for (const name of names) {
      map.set(name, group);
      map.set(normalizeEntityName(name), group);
    }
    if (inv.id) {
      map.set(inv.id, group);
    }
    if (group && group.trim()) {
      map.set(group, group);
      map.set(normalizeEntityName(group), group);
    }
  }
  return map;
}

/**
 * Resolves an investor's group name from a lookup map created by `buildInvestorGroupLookup`.
 * Returns the parent group name, or null if the entity has no group or is 'Unspecified'.
 */
export function resolveInvestorGroupName(
  lookup: Map<string, string | null>,
  name: string,
): string | null {
  if (!name || name === 'Unspecified') return null;
  if (lookup.has(name)) {
    return lookup.get(name) ?? null;
  }
  const norm = normalizeEntityName(name);
  if (lookup.has(norm)) {
    return lookup.get(norm) ?? null;
  }
  return null;
}


// ---- investment-type helpers ----
export function normalizeInvestType(v?: string) {
  if (v === 'Fund of Funds') return v;
  if (v === 'Direct Investment') return v;
  return 'Others';
}
export function defaultInvestType(tp: string) {
  if (tp === 'Fund of funds') return 'Fund of Funds';
  if (tp === 'Equity') return 'Direct Investment';
  return 'Others';
}
export function getAssetInvestType(h: Holding) {
  return normalizeInvestType(h.investType || h.inv?.investType || defaultInvestType(h.tp));
}
export function setAssetInvestType(h: Holding, v: string) {
  const t = normalizeInvestType(v);
  h.investType = t;
  if (h.inv) h.inv.investType = t;
}
export function isFoF(h: Holding) {
  return h.tp === 'Fund of funds';
}

/** Value-based holdings (no share/PPS ledger) — Fund of funds and Cash both
 * roll up from transaction values via `computeFoF`. */
export function isValueBased(h: Holding) {
  return h.tp === 'Fund of funds' || h.tp === 'Cash';
}

export function isGeneratedCashMovement(t: Txn): boolean {
  return Boolean(t.isGenerated || t.sourceDivestmentTxnId);
}

export function isEstimatedTxn(t: Txn): boolean {
  return Boolean(t.isEstimated);
}

export function isAdjustmentTxn(t: Txn): boolean {
  if (t.entryType === 'adjustment') return true;
  if (
    t.rawValuationDelta &&
    !flIsZero(t.rawValuationDelta) &&
    (!t.rawCashDelta || flIsZero(t.rawCashDelta))
  ) {
    return true;
  }
  return false;
}

/**
 * Computes the signed cash delta in display MILLIONS for an 'Other' transaction.
 *
 * Scale discipline:
 * Value is in millions; rawCashDelta is in units.
 * We use rawCashDelta for its sign only, and apply that sign to the existing
 * millions-scaled magnitude (txnValue(t) ?? t.value ?? 0).
 *
 * Rules:
 * 1. Generated cash movements (isGeneratedCashMovement) produce 0.
 * 2. Valuation adjustments (entryType === 'adjustment') are revaluations, not cash flows -> 0.
 * 3. Estimated transactions (isEstimatedTxn) are projections, not actual cash flows -> 0.
 * 4. Actual cash movements:
 *    - If rawCashDelta is present and non-zero: sign follows rawCashDelta.
 *    - Otherwise, entryType === 'expense' -> negative (-1).
 *    - entryType === 'income' (or recognized income labels) -> positive (+1).
 *    - Default for Other is outflow -> negative (-1).
 */
export function signedOtherCashDelta(t: Txn): number {
  if (isGeneratedCashMovement(t)) return 0;
  if (isAdjustmentTxn(t)) return 0;
  if (isEstimatedTxn(t)) return 0;

  const mag = Math.abs(txnValue(t) ?? t.value ?? 0);
  if (mag === 0) return 0;

  // Scale discipline: use rawCashDelta for sign only when present and non-zero
  if (t.rawCashDelta && !flIsZero(t.rawCashDelta)) {
    const isNegative = t.rawCashDelta.trim().startsWith('-');
    return isNegative ? -mag : mag;
  }

  if (t.entryType === 'expense') {
    return -mag;
  }
  if (t.entryType === 'income') {
    return mag;
  }

  const isIncome =
    t.label === 'Interest income' ||
    t.label === 'Dividend' ||
    t.label === 'Return of capital' ||
    t.label === 'Distribution';

  if (isIncome) {
    return mag;
  }

  return -mag;
}

export function txnTypeLabel(
  t: {
    type: string;
    label?: string;
    isGenerated?: boolean;
    isReversal?: boolean;
    sourceDivestmentTxnId?: string | null;
    sellProceedsDestination?: SellProceedsDestination | null;
  },
  h: Holding,
) {
  if (t.sourceDivestmentTxnId || t.label === 'Retained sale proceeds' || (t.isGenerated && !t.isReversal)) {
    return 'Retained sale proceeds';
  }
  if (t.isReversal) {
    if (t.label) return `Reversal: ${t.label}`;
    const base = getBaseTxnTypeLabel(t, h);
    return `Reversal: ${base}`;
  }
  return getBaseTxnTypeLabel(t, h);
}

function getBaseTxnTypeLabel(
  t: {
    type: string;
    label?: string;
    sellProceedsDestination?: SellProceedsDestination | null;
  },
  h: Holding,
): string {
  if (h.tp === 'Cash') {
    if (t.type === 'Buy') return 'Deposit';
    if (t.type === 'Sell') {
      return t.sellProceedsDestination === 'distributed_to_investor'
        ? 'Distribution'
        : 'Withdrawal';
    }
    if (t.type === 'Other') return t.label || 'Interest / adjustment';
    return t.type;
  }
  if (isFoF(h)) {
    if (t.type === 'Buy') return 'Capital call';
    if (t.type === 'Sell') {
      return t.sellProceedsDestination === 'distributed_to_investor'
        ? 'Distribution'
        : 'Divestment';
    }
    if (t.type === 'Other') return t.label || 'Other';
    return t.type;
  }
  return (
    ({
      Buy: 'Purchase',
      Sell: 'Divestment',
      Other: t.label || 'Other',
    } as Record<string, string>)[t.type] || t.type
  );
}

export const PROCEEDS_TREATMENT_OPTIONS = [
  { value: 'cash_in_fund', label: 'Convert to cash in fund' },
  { value: 'distributed_to_investor', label: 'Distribute to investor' },
] as const;

/**
 * A Cash holding IS the fund's cash, so "convert to cash in fund" would
 * resolve back to the same asset and generate a self-referencing internal
 * transfer. Cash sells can only be distributed to the investor.
 */
export function proceedsTreatmentOptionsFor(holdingType?: string) {
  return holdingType === 'Cash'
    ? PROCEEDS_TREATMENT_OPTIONS.filter((o) => o.value === 'distributed_to_investor')
    : PROCEEDS_TREATMENT_OPTIONS;
}

/** Label for the proceeds treatment on a sell transaction. */
export function proceedsTreatmentLabel(
  destination: SellProceedsDestination | null | undefined,
  type?: string,
): string {
  if (type !== undefined && type !== 'Sell') return '—';
  if (destination === 'cash_in_fund') return 'Cash in fund';
  if (destination === 'distributed_to_investor') return 'Investor distribution';
  return '—';
}

export interface TxnDialogValidationInput {
  date?: string | null;
  value?: string | number | null;
  pps?: string | number | null;
  shares?: string | number | null;
  type?: TxnType | string;
  sellProceedsDestination?: string | null;
  fundId?: string | null;
  fof?: boolean;
  isCash?: boolean;
}

/** Form validation for the add/edit transaction dialog. */
export function canSubmitTxnDialog(input: TxnDialogValidationInput): boolean {
  const hasDate = Boolean(input.date && input.date.trim() !== '');
  const hasValue = input.value != null && String(input.value).trim() !== '';
  const hasPps = input.pps != null && String(input.pps).trim() !== '';
  const hasShares = input.shares != null && String(input.shares).trim() !== '';
  const hasPpsShares = !input.fof && hasPps && hasShares;
  const isSell = input.type === 'Sell';
  const hasProceeds =
    !isSell ||
    (!input.isCash && input.sellProceedsDestination === 'cash_in_fund') ||
    input.sellProceedsDestination === 'distributed_to_investor';
  const requiresFund = isSell && !input.isCash && input.sellProceedsDestination === 'cash_in_fund';
  const hasFund =
    !requiresFund ||
    (input.fundId != null && input.fundId.trim() !== '' && input.fundId !== 'unassigned');

  return hasDate && (hasValue || hasPpsShares) && hasProceeds && hasFund;
}

/** Updates sell proceeds destination when switching transaction types in the dialog. */
export function getNextSellProceedsDestination(
  newType: TxnType | string,
  currentDestination?: string | null,
): string {
  return newType === 'Sell' ? (currentDestination ?? '') : '';
}

/**
 * A transaction's cash value, in millions. By default it's Price-Per-Share ×
 * Number of Shares; an explicitly entered `value` overrides that. `pps` is a
 * raw per-unit price and `shares` are already in millions, so `pps * shares`
 * lands in millions too — matching the domain's money scale. Returns null when
 * neither an explicit value nor a full pps/shares pair is present.
 */
export function txnValue(t: {
  value?: number | null;
  pps?: number | null;
  shares?: number | null;
}): number | null {
  if (t.value != null) return t.value;
  if (t.pps != null && t.shares != null) return t.pps * t.shares;
  return null;
}

export interface CashFlow {
  date: string | Date;
  amount: number;
}

/**
 * Calculates the exact annualized Internal Rate of Return (XIRR) for irregular cash flows.
 * Returns an IrrResult carrying value, status ('calculated' | 'unavailable'), and explicit reason:
 * - 'calculated': Genuine root found (including true 0%).
 * - 'insufficient_flows': Fewer than 2 valid nonzero dated flows.
 * - 'no_sign_change': Flows are all-positive or all-negative.
 * - 'did_not_converge': Solver failed to converge to a valid rate.
 */
export function calculateXirr(cashFlows: CashFlow[], guess = 0.1): IrrResult {
  if (!cashFlows || cashFlows.length < 2) {
    return { value: null, status: 'unavailable', reason: 'insufficient_flows' };
  }

  const validFlows = cashFlows
    .map((cf) => ({
      dateMs: typeof cf.date === 'string' ? new Date(cf.date).getTime() : cf.date.getTime(),
      amount: cf.amount,
    }))
    .filter((cf) => !Number.isNaN(cf.dateMs) && Number.isFinite(cf.amount) && Math.abs(cf.amount) > 1e-12)
    .sort((a, b) => a.dateMs - b.dateMs);

  if (validFlows.length < 2) {
    return { value: null, status: 'unavailable', reason: 'insufficient_flows' };
  }

  const minDate = validFlows[0].dateMs;
  let hasPositive = false;
  let hasNegative = false;

  const flows = validFlows.map((cf) => {
    if (cf.amount > 0) hasPositive = true;
    if (cf.amount < 0) hasNegative = true;
    const years = (cf.dateMs - minDate) / (365.25 * 24 * 3600 * 1000);
    return { t: years, amount: cf.amount };
  });

  if (!hasPositive || !hasNegative) {
    return { value: null, status: 'unavailable', reason: 'no_sign_change' };
  }

  const npv = (rate: number): number => {
    if (rate <= -1) return Number.POSITIVE_INFINITY;
    return flows.reduce((sum, cf) => sum + cf.amount / Math.pow(1 + rate, cf.t), 0);
  };

  const dnpv = (rate: number): number => {
    if (rate <= -1) return Number.NEGATIVE_INFINITY;
    return flows.reduce((sum, cf) => sum - (cf.t * cf.amount) / Math.pow(1 + rate, cf.t + 1), 0);
  };

  let rate = guess;
  const maxIterations = 100;
  const tol = 1e-7;

  for (let i = 0; i < maxIterations; i++) {
    const val = npv(rate);
    if (Math.abs(val) < tol) {
      const finalRate = Math.abs(rate) < 1e-12 ? 0 : rate;
      return { value: finalRate, status: 'calculated', reason: 'calculated' };
    }
    const deriv = dnpv(rate);
    if (Math.abs(deriv) < 1e-12) break;

    const newRate = rate - val / deriv;
    if (newRate <= -0.9999 || !Number.isFinite(newRate)) {
      break;
    }
    if (Math.abs(newRate - rate) < tol) {
      const finalRate = Math.abs(newRate) < 1e-12 ? 0 : newRate;
      return { value: finalRate, status: 'calculated', reason: 'calculated' };
    }
    rate = newRate;
  }

  let low = -0.9999;
  let high = 10.0;
  let npvLow = npv(low);
  let npvHigh = npv(high);

  if (npvLow * npvHigh > 0) {
    for (let expand = 0; expand < 10 && npvLow * npvHigh > 0; expand++) {
      high *= 2;
      npvHigh = npv(high);
    }
  }

  if (npvLow * npvHigh <= 0) {
    for (let i = 0; i < 100; i++) {
      const mid = (low + high) / 2;
      const npvMid = npv(mid);
      if (Math.abs(npvMid) < tol || (high - low) / 2 < tol) {
        const finalMid = Math.abs(mid) < 1e-12 ? 0 : mid;
        return { value: finalMid, status: 'calculated', reason: 'calculated' };
      }
      if (npvLow * npvMid < 0) {
        high = mid;
        npvHigh = npvMid;
      } else {
        low = mid;
        npvLow = npvMid;
      }
    }
    const candidate = (low + high) / 2;
    if (Math.abs(npv(candidate)) < tol) {
      const finalCand = Math.abs(candidate) < 1e-12 ? 0 : candidate;
      return { value: finalCand, status: 'calculated', reason: 'calculated' };
    }
    return { value: null, status: 'unavailable', reason: 'did_not_converge' };
  }

  return { value: null, status: 'unavailable', reason: 'did_not_converge' };
}

export function calculateXirrNumber(cashFlows: CashFlow[], guess = 0.1): number {
  return calculateXirr(cashFlows, guess).value ?? 0;
}

// ---- equity metrics ----
/**
 * Canonical calculation-side guard for effective transactions.
 * Portfolio adapters retain all entries so transaction tables display full
 * original and reversal audit history. `effectiveTransactions` ensures that:
 * - In present-day views, reversed originals and their balancing reversals are excluded
 *   so metrics reflect only active economics / active replacements.
 * - In date-aware historical as-of views, an original transaction remains effective
 *   prior to its linked reversal date, and nets/excludes once the reversal date is reached.
 */
export function effectiveTransactions(txns: Txn[], asOfDate?: string | null): Txn[] {
  const dateFiltered = asOfDate
    ? txns.filter((t) => Boolean(t.date && t.date <= asOfDate))
    : txns;

  const reversalDatesByPosition = new Map<string, string[]>();
  for (const t of txns) {
    if (t.isReversal && t.date) {
      const posKey = t.positionId ?? '__all__';
      const list = reversalDatesByPosition.get(posKey) ?? [];
      list.push(t.date);
      reversalDatesByPosition.set(posKey, list);
    }
  }

  return dateFiltered.filter((txn) => {
    if (txn.isReversal) {
      return false;
    }

    if (txn.isReversedOriginal) {
      let revDate = txn.reversalDate;
      if (!revDate) {
        const posKey = txn.positionId ?? '__all__';
        const list = reversalDatesByPosition.get(posKey) ?? reversalDatesByPosition.get('__all__');
        if (list && list.length > 0) {
          revDate = list.find((d) => !txn.date || d >= txn.date) ?? list[0];
        }
      }

      if (asOfDate && revDate && asOfDate < revDate) {
        return true;
      }

      return false;
    }

    return true;
  });
}

/**
 * Selects the latest eligible quarterly mark from an array of Quarter objects.
 *
 * Rules:
 * 1. When `effectiveAsOf` is provided:
 *    Only marks with a defined `asOfDate` on or before `effectiveAsOf` are eligible.
 *    Undated marks have an unknown observation date and cannot be assumed eligible
 *    under a historical cutoff (conservative reading to avoid future data leaks).
 *    Among eligible marks, returns the one with the greatest `asOfDate` (breaking ties
 *    by later array index).
 * 2. When `effectiveAsOf` is undefined (no cutoff supplied, present day):
 *    If any marks have an `asOfDate`, returns the one with the greatest `asOfDate`
 *    (avoiding reliance on array position if marks were appended out of order).
 *    If all marks are undated, returns the last element of the array to preserve
 *    existing present-day behaviour.
 */
export function selectEligibleMark(
  quarterly: Quarter[] | undefined,
  effectiveAsOf?: string,
): Quarter | null {
  if (!quarterly || quarterly.length === 0) return null;

  if (effectiveAsOf !== undefined) {
    let latestEligible: Quarter | null = null;
    for (const q of quarterly) {
      if (q.asOfDate && q.asOfDate <= effectiveAsOf) {
        if (!latestEligible || !latestEligible.asOfDate || q.asOfDate >= latestEligible.asOfDate) {
          latestEligible = q;
        }
      }
    }
    return latestEligible;
  }

  // No cutoff: behaviour must be unchanged from today (latest mark wins).
  // Check if dated marks exist to handle out-of-order arrays.
  let latestDated: Quarter | null = null;
  let hasDated = false;
  for (const q of quarterly) {
    if (q.asOfDate) {
      hasDated = true;
      if (!latestDated || !latestDated.asOfDate || q.asOfDate >= latestDated.asOfDate) {
        latestDated = q;
      }
    }
  }

  if (hasDated) {
    return latestDated;
  }

  // All marks are undated: return array's last element to preserve today's behavior.
  return quarterly[quarterly.length - 1];
}

export function computeInv(h: Holding, asOfDate?: string): EquityMetrics | null {
  const inv = h.inv;
  if (!inv) return null;
  const effectiveAsOf = (asOfDate || h.asOfDate || inv.asOfDate) || undefined;
  const txns = effectiveTransactions(inv.txns || [], effectiveAsOf);
  const buys = txns.filter((t) => t.type === 'Buy' && !isGeneratedCashMovement(t));
  const sells = txns.filter((t) => t.type === 'Sell' && !isGeneratedCashMovement(t));
  const others = txns.filter(
    (t) =>
      t.type === 'Other' &&
      !isGeneratedCashMovement(t) &&
      !isAdjustmentTxn(t) &&
      !isEstimatedTxn(t),
  );

  const investedCapital = buys.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const realizedProceedsGross = sells.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const otherVal = others.reduce((s, t) => s + signedOtherCashDelta(t), 0);
  const divestment = sells.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const sharesAcquired = buys.reduce((s, t) => s + (t.shares || 0), 0);
  const sharesDisposed = sells.reduce((s, t) => s + (t.shares || 0), 0);
  const sharesHeld = sharesAcquired - sharesDisposed;
  const blendedEntryPrice = sharesAcquired ? investedCapital / sharesAcquired : 0;

  const mark = selectEligibleMark(inv.quarterly, effectiveAsOf);

  let curPrice: number | null;
  let unrealizedValue: number | null;
  let terminalDate: string | null;

  if (effectiveAsOf) {
    // Cutoff in force:
    if (sharesAcquired > 0 && sharesHeld === 0) {
      // Fully exited: no remaining shares, unrealized value is 0.
      unrealizedValue = 0;
      curPrice =
        mark?.pps != null
          ? mark.pps
          : mark && mark.mv != null && sharesAcquired > 0
            ? mark.mv / sharesAcquired
            : null;
      terminalDate = mark?.asOfDate ?? null;
    } else if (mark) {
      curPrice =
        mark.pps != null
          ? mark.pps
          : mark.mv != null && sharesHeld > 0
            ? mark.mv / sharesHeld
            : null;

      if (sharesAcquired > 0) {
        unrealizedValue =
          curPrice != null
            ? sharesHeld * curPrice
            : mark.mv != null
              ? mark.mv
              : null;
      } else {
        unrealizedValue = mark.mv ?? null;
      }
      terminalDate = mark.asOfDate ?? null;
    } else {
      // No eligible mark exists under cutoff: do not silently substitute current price, h.fmv, or today's date.
      curPrice = null;
      unrealizedValue = null;
      terminalDate = null;
    }
  } else {
    // No cutoff supplied: behaviour must be unchanged from today (latest mark wins, h.fmv fallback).
    curPrice =
      inv._cur != null
        ? inv._cur
        : mark?.pps != null
          ? mark.pps
          : sharesHeld && h.fmv != null
            ? h.fmv / sharesHeld
            : null;

    const latestMv = mark ? mark.mv ?? null : null;
    unrealizedValue =
      sharesAcquired > 0 && sharesHeld === 0
        ? 0
        : inv._cur != null && sharesHeld
          ? sharesHeld * inv._cur
          : sharesHeld && curPrice != null
            ? sharesHeld * curPrice
            : latestMv != null
              ? latestMv
              : h.fmv;

    const latestQDate = mark?.asOfDate ?? null;
    terminalDate = latestQDate || h.dt || new Date().toISOString().slice(0, 10);
  }

  const totalValueGross =
    unrealizedValue != null ? realizedProceedsGross + otherVal + unrealizedValue : null;
  const holdYrs = (h.d && h.d.holdYrs) || 3;

  const subscriptionFee = inv.subscriptionFee || 0;
  const mgmtFeeRatePct = inv.mgmtFeeRate || 0;
  const mgmtFeeRate = mgmtFeeRatePct / 100;
  const prefReturnRatePct = inv.prefReturnRate ?? 8;
  const prefReturnRate = prefReturnRatePct / 100;
  const carryRatePct = inv.carryRate || 0;
  const carryRate = carryRatePct / 100;
  const legalFees = inv.legalFees || 0;
  const cumulativeMgmtFees = investedCapital * mgmtFeeRate * holdYrs;
  const allInCostBasis = investedCapital + cumulativeMgmtFees;

  const totalGrossGain = totalValueGross != null ? totalValueGross - investedCapital : null;
  const carryOwed = totalGrossGain != null ? Math.max(0, totalGrossGain) * carryRate : null;
  const netTotalValue = totalValueGross != null && carryOwed != null ? totalValueGross - carryOwed : null;

  const mgmtFeeVal = cumulativeMgmtFees;
  const prefReturnVal = investedCapital * prefReturnRate * holdYrs;
  const carryVal = carryOwed;
  const totalFeesVal = -(mgmtFeeVal + (carryVal ?? 0));

  const grossMOIC = totalValueGross != null && investedCapital ? totalValueGross / investedCapital : null;
  const netMOIC = netTotalValue != null && allInCostBasis ? netTotalValue / allInCostBasis : null;
  const dpi = investedCapital ? realizedProceedsGross / investedCapital : 0;
  const unreal = curPrice != null && blendedEntryPrice ? (curPrice - blendedEntryPrice) / blendedEntryPrice : null;

  // Build dated cash flows for XIRR
  const cashFlows: CashFlow[] = [];
  txns.forEach((t) => {
    if (!t.date || isGeneratedCashMovement(t)) return;
    const isBuyTxn = t.type === 'Buy' || t.entryType === 'paid_in' || t.entryType === 'buy';
    const isSellTxn = t.type === 'Sell' || t.entryType === 'distribution' || t.entryType === 'redemption' || t.entryType === 'sell';
    const val = txnValue(t) ?? 0;
    if (isBuyTxn) {
      if (val > 0) cashFlows.push({ date: t.date, amount: -val });
    } else if (isSellTxn) {
      if (val > 0) cashFlows.push({ date: t.date, amount: val });
    } else if (t.type === 'Other') {
      const delta = signedOtherCashDelta(t);
      if (delta !== 0) {
        cashFlows.push({ date: t.date, amount: delta });
      }
    }
  });

  if (unrealizedValue != null && unrealizedValue > 0 && terminalDate != null) {
    cashFlows.push({ date: terminalDate, amount: unrealizedValue });
  }

  const grossIRR = unrealizedValue != null ? calculateXirr(cashFlows) : null;
  const netIRR = grossIRR;

  const quarterly: Quarter[] = inv.quarterly && inv.quarterly.length ? inv.quarterly : [];

  return {
    investedCapital,
    realizedProceedsGross,
    otherVal,
    divestment,
    sharesAcquired,
    sharesDisposed,
    sharesHeld,
    blendedEntryPrice,
    curPrice,
    unrealizedValue,
    totalValueGross,
    holdYrs,
    mgmtFeeRate,
    carryRate,
    legalFees,
    subscriptionFee,
    cumulativeMgmtFees,
    allInCostBasis,
    prefReturnRatePct,
    mgmtFeeVal,
    prefReturnVal,
    carryVal: carryVal ?? 0,
    totalFeesVal,
    totalGrossGain,
    carryOwed: carryOwed ?? 0,
    netTotalValue,
    grossMOIC,
    netMOIC,
    dpi,
    grossIRR,
    netIRR,
    unreal,
    avgBuy: blendedEntryPrice,
    avgSell: sharesDisposed ? divestment / sharesDisposed : 0,
    addOn: subscriptionFee + legalFees,
    terminalDate,
    quarterly,
  };
}

// ---- fund-of-funds metrics ----
export function computeFoF(h: Holding, asOfDate?: string): FoFMetrics | null {
  const inv = h.inv;
  if (!inv) return null;
  const effectiveAsOf = (asOfDate || h.asOfDate || inv.asOfDate) || undefined;
  const txns = effectiveTransactions(inv.txns || [], effectiveAsOf);
  const calls = txns.filter((t) => t.type === 'Buy' && !isGeneratedCashMovement(t));
  const dists = txns.filter((t) => t.type === 'Sell' && !isGeneratedCashMovement(t));
  const others = txns.filter(
    (t) =>
      t.type === 'Other' &&
      !isGeneratedCashMovement(t) &&
      !isAdjustmentTxn(t) &&
      !isEstimatedTxn(t),
  );
  const totalCalled = calls.reduce((s, t) => s + (t.value || 0), 0);
  const totalDist = dists.reduce((s, t) => s + (t.value || 0), 0);
  const totalOther = others.reduce((s, t) => s + signedOtherCashDelta(t), 0);
  const costInv = totalCalled;
  const netDist = totalDist + totalOther;

  const mark = selectEligibleMark(inv.quarterly, effectiveAsOf);

  let marketValue: number | null;
  let terminalDate: string | null;

  if (effectiveAsOf) {
    // Cutoff in force: only an eligible mark (asOfDate <= effectiveAsOf) may supply market value.
    // If no eligible mark exists, marketValue is unavailable (null) — never fall back to h.fmv.
    marketValue = mark && mark.mv != null ? mark.mv : null;
    terminalDate = mark?.asOfDate ?? null;
  } else {
    // No cutoff: behaviour unchanged from today. Latest mark wins, falling back to h.fmv.
    marketValue = mark && mark.mv != null ? mark.mv : h.fmv;
    terminalDate = mark?.asOfDate || h.dt || new Date().toISOString().slice(0, 10);
  }

  const moic = marketValue != null && costInv ? (marketValue + netDist) / costInv : null;
  const dpi = costInv ? netDist / costInv : 0;

  const fofCashFlows: CashFlow[] = [];
  txns.forEach((t) => {
    if (!t.date || isGeneratedCashMovement(t)) return;
    const isBuyTxn = t.type === 'Buy' || t.entryType === 'paid_in' || t.entryType === 'buy';
    const isSellTxn = t.type === 'Sell' || t.entryType === 'distribution' || t.entryType === 'redemption' || t.entryType === 'sell';
    const val = t.value ?? 0;
    if (isBuyTxn) {
      if (val > 0) fofCashFlows.push({ date: t.date, amount: -val });
    } else if (isSellTxn) {
      if (val > 0) fofCashFlows.push({ date: t.date, amount: val });
    } else if (t.type === 'Other') {
      const delta = signedOtherCashDelta(t);
      if (delta !== 0) {
        fofCashFlows.push({ date: t.date, amount: delta });
      }
    }
  });

  if (marketValue != null && marketValue > 0 && terminalDate != null) {
    fofCashFlows.push({ date: terminalDate, amount: marketValue });
  }

  const xirr = marketValue != null ? calculateXirr(fofCashFlows) : null;

  return {
    totalCalled,
    totalDist,
    totalOther,
    costInv,
    marketValue,
    netDist,
    moic,
    dpi,
    xirr,
    callsCount: calls.length,
    distsCount: dists.length,
    othersCount: others.length,
    terminalDate,
    quarterly: inv.quarterly || [],
  };
}

// ---- fund + portfolio aggregates ----
const ABBR: Record<string, string> = {
  Equity: 'Companies',
  Obligation: 'Loans',
  Shares: 'Shares',
  Cash: 'Cash',
  'Fund of funds': 'Funds',
};
export function holdingBreakdown(holdings: Holding[]) {
  const c: Record<string, number> = {};
  holdings.forEach((x) => {
    if (x.displayOnly) return;
    const k = ABBR[x.tp] || x.tp;
    c[k] = (c[k] || 0) + 1;
  });
  return Object.entries(c)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
}

export function growth(arr: (number | null)[]): number | null {
  const n = arr.length;
  if (n < 2) return 0;
  const c = arr[n - 1];
  const p = arr[n - 2];
  if (c === null || p === null) return null;
  return p === 0 ? 0 : ((c - p) / p) * 100;
}

type FundHistLike = {
  committed: number[];
  called: number[];
  fmv: (number | null)[];
  tvpi?: (number | null)[];
};

export function sumHist(funds: Fund[], key: keyof FundHistLike): (number | null)[] {
  return QLABELS.map((_, qi) => {
    let sum = 0;
    for (const f of funds) {
      if (f.displayOnly) continue;
      if (f.hist && f.hist[key]) {
        const val = f.hist[key]![qi];
        if (val === null) {
          return null;
        }
        if (val !== undefined) {
          sum += val;
        }
      }
    }
    return sum;
  });
}

export interface PortfolioTotals {
  commitment: number;
  invested: number;
  fmv: number | null;
  real: number;
  moic: number | null;
  valuationCoverage: ValuationCoverage;
  committedHist: (number | null)[];
  calledHist: (number | null)[];
  fmvHist: (number | null)[];
  tvpiHist: (number | null)[];
}
export function portfolioTotals(funds: Fund[]): PortfolioTotals {
  const activeFunds = funds.filter((f) => !f.displayOnly);
  const commitment = activeFunds.reduce((s, f) => s + f.size, 0);
  const invested = activeFunds.reduce((s, f) => s + f.called, 0);
  const real = activeFunds.reduce((s, f) => s + f.real, 0);

  const anyUnvalued = activeFunds.some(
    (f) => f.valuationCoverage === 'partial' || f.h.filter((h) => !h.displayOnly).some((h) => h.fmv === null || h.valuationMethod === null),
  );
  const valuationCoverage: ValuationCoverage = anyUnvalued ? 'partial' : 'complete';

  // Unrealized MV is holdings-only (never cash), so cash FX status cannot block it.
  // Null ("—") until at least one fund has a valued holding.
  const anyValued = activeFunds.some((f) => f.fmv !== null);
  const fmv = anyValued ? activeFunds.reduce((s, f) => s + (f.fmv ?? 0), 0) : null;
  const moic = valuationCoverage === 'partial' || !invested || fmv === null ? null : (fmv + real) / invested;

  const committedHist = sumHist(activeFunds, 'committed');
  const calledHist = sumHist(activeFunds, 'called');
  const fmvHist = sumHist(activeFunds, 'fmv');
  const tvpiHist = QLABELS.map((_, qi) => {
    const fmvVal = fmvHist[qi];
    if (fmvVal === null) return null;
    for (const f of activeFunds) {
      if (f.hist?.tvpi && f.hist.tvpi[qi] === null) {
        return null;
      }
    }
    const c = calledHist[qi];
    if (c === null) return null;
    if (qi === QLABELS.length - 1) {
      return c ? (fmvVal + real) / c : 0;
    }
    if (activeFunds.length === 1 && activeFunds[0].hist?.tvpi?.[qi] != null) {
      return activeFunds[0].hist.tvpi[qi];
    }
    if (real === 0) {
      return c ? fmvVal / c : 0;
    }
    return null;
  });
  return {
    commitment,
    invested,
    fmv,
    real,
    moic,
    valuationCoverage,
    committedHist,
    calledHist,
    fmvHist,
    tvpiHist,
  };
}


/**
 * Capital this investment entity has actually invested, in millions —
 * the sum of its own contribution (Buy) transactions across every holding,
 * rather than a pro-rata slice of each fund's called amount. Transactions
 * carry the entity's id in `holdingEntityId` (resolved server-side), so we
 * match on `entityId`. Commitment still comes from the DB (the stake), but
 * invested is computed here from the ledger.
 */
export function investorInvestedInFund(entityId: string, fund: Fund): number {
  if (fund.displayOnly) return 0;
  let invested = 0;
  fund.h.forEach((h) => {
    if (h.displayOnly) return;
    (h.inv?.txns || []).forEach((t) => {
      if (t.type === 'Buy' && t.holdingEntityId === entityId) invested += txnValue(t) ?? 0;
    });
  });
  return invested;
}



// ---- source-of-fund aggregates ----
/** The capital pool(s) that funded a holding, split from the free-text field. */
export function getAssetFundingSources(h: Holding): string[] {
  const raw = ((h.inv && h.inv.fundingSource) || (h.d && h.d.fundingSource) || '').trim();
  if (!raw || raw === 'NA') return ['Unspecified'];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)] : ['Unspecified'];
}

export interface SourceHolding {
  h: Holding;
  f: Fund;
  hkey: string;
}


// ---- investment-entity aggregates ----
/** The investing entity a holding belongs to (type_details.investingEntity). */
export function getAssetEntity(h: Holding): string | null {
  const raw = ((h.inv && h.inv.entity) || (h.d && h.d.entity) || '').trim();
  return raw || null;
}



export interface SourceAgg {
  cost: number;
  fmv: number;
  real: number;
  gain: number | null;
  moic: number | null;
  count: number;
  valuationCoverage: ValuationCoverage;
}


// ============================================================================
// Transaction-level attribution
// ----------------------------------------------------------------------------
// Every rollup below is derived from the transaction ledger: each transaction
// is attributed to its own dimension key (holding entity / source of fund),
// falling back to the asset's assignment when a transaction leaves that field
// blank. Invested (cost) and Realized come straight from the ledger; Unrealized
// market value — which has no per-transaction figure — is allocated within each
// asset across the buckets that transacted in it, pro-rata by net shares held
// (then invested cost, then an even split). The split always reconciles exactly
// to the holding's own totals, so every view ties out to the Asset tab.
// ============================================================================

export const OTHERS_ENTITY = 'Others';

/** The value of one Buy/Sell leg — share-priced when the ledger tracks shares,
 * otherwise the raw amount. Mirrors `computeInv`'s per-txn convention. */
function legValue(t: { pps?: number | null; shares?: number | null; value?: number | null }): number {
  return t.pps && t.shares ? t.pps * t.shares : t.value || 0;
}

/** One holding's cost / realized / market value split across the buckets a
 * `keyFor(txn)` assigns its ledger to. Returns an empty map for a ledger
 * holding with no transactions, and `null` for a holding with no `inv` ledger. */
export function splitHoldingByTxn(
  h: Holding,
  f: Fund,
  keyFor: (t: Txn, h: Holding, f: Fund) => string,
): Map<string, { cost: number; real: number; fmv: number | null }> | null {
  const inv = h.inv;
  if (!inv) return null;
  const valueBased = isValueBased(h);
  const per = new Map<string, { cost: number; real: number; shares: number }>();
  const bucket = (k: string) => {
    let b = per.get(k);
    if (!b) {
      b = { cost: 0, real: 0, shares: 0 };
      per.set(k, b);
    }
    return b;
  };

  (inv.txns || []).forEach((t) => {
    const b = bucket(keyFor(t, h, f));
    if (valueBased) {
      if (t.type === 'Buy') {
        b.cost += t.value || 0;
      } else if (t.type === 'Sell') {
        b.real += t.value || 0;
      } else if (t.type === 'Other') {
        b.real += signedOtherCashDelta(t);
      }
    } else {
      if (t.type === 'Buy') {
        b.cost += legValue(t);
        b.shares += t.shares || 0;
      } else if (t.type === 'Sell') {
        b.real += legValue(t);
        b.shares -= t.shares || 0;
      }
    }
  });

  const out = new Map<string, { cost: number; real: number; fmv: number | null }>();
  const keys = [...per.keys()];
  if (keys.length === 0) return out;
  const totalShares = keys.reduce((s, k) => s + Math.max(0, per.get(k)!.shares), 0);
  const totalCost = keys.reduce((s, k) => s + per.get(k)!.cost, 0);
  let allocated = 0;
  keys.forEach((k, i) => {
    const b = per.get(k)!;
    if (h.fmv === null) {
      out.set(k, { cost: b.cost, real: b.real, fmv: null });
      return;
    }
    let weight: number;
    if (totalShares > 0) weight = Math.max(0, b.shares) / totalShares;
    else if (totalCost > 0) weight = b.cost / totalCost;
    else weight = 1 / keys.length;
    // Last bucket absorbs the remainder so the split reconciles exactly.
    const fmvShare = i === keys.length - 1 ? h.fmv - allocated : h.fmv * weight;
    allocated += fmvShare;
    out.set(k, { cost: b.cost, real: b.real, fmv: fmvShare });
  });
  return out;
}

/**
 * Scope a shared asset's holding down to a single fund's share.
 *
 * Fund membership is transaction-driven: an asset is returned for every fund
 * its ledger names (see FlPortfolioService.getPortfolio / FlPositionRepository.findByFundIds), so a co-invested
 * asset arrives once per fund, each copy carrying the WHOLE-asset numbers and
 * the FULL ledger. Left as-is that double-counts. Here we keep only this fund's
 * transactions and scale the whole-asset invested / realized / market value by
 * this fund's ledger share, so summing the per-fund copies reconciles back to
 * the asset total. A single-fund asset (every transaction already belongs to
 * `fundId`) is returned untouched.
 */
export function scopeHoldingToFund(h: Holding, fundId: string): Holding {
  const inv = h.inv;
  if (!inv || !inv.txns || inv.txns.length === 0) return h;

  // The synthetic "Unassigned Assets" fund owns transactions with no fund
  // assignment (fund_id = null). Map the sentinel back to null so comparisons
  // match correctly — otherwise every null-fund transaction is skipped and
  // the asset's entire invested capital is zeroed out.
  const txnFundId: string | null = fundId === 'unassigned' ? null : fundId;

  const scoped = inv.txns.filter((t) => (t.fundId ?? null) === txnFundId);
  // Whole ledger already belongs to this fund → nothing to split.
  if (scoped.length === inv.txns.length) return h;

  const valueBased = isValueBased(h);
  let fundCost = 0;
  let totalCost = 0;
  let fundReal = 0;
  let totalReal = 0;
  let fundShares = 0;
  let totalShares = 0;
  inv.txns.forEach((t) => {
    const mine = (t.fundId ?? null) === txnFundId;
    if (valueBased) {
      if (t.type === 'Buy') {
        totalCost += t.value || 0;
        if (mine) fundCost += t.value || 0;
      } else if (t.type === 'Sell') {
        totalReal += t.value || 0;
        if (mine) fundReal += t.value || 0;
      } else if (t.type === 'Other') {
        const delta = signedOtherCashDelta(t);
        totalReal += delta;
        if (mine) fundReal += delta;
      }
    } else if (t.type === 'Buy') {
      const v = legValue(t);
      const s = t.shares || 0;
      totalCost += v;
      totalShares += s;
      if (mine) {
        fundCost += v;
        fundShares += s;
      }
    } else if (t.type === 'Sell') {
      const v = legValue(t);
      const s = t.shares || 0;
      totalReal += v;
      totalShares -= s;
      if (mine) {
        fundReal += v;
        fundShares -= s;
      }
    }
  });

  const costFrac = totalCost > 0 ? fundCost / totalCost : 0;
  const realFrac = totalReal > 0 ? fundReal / totalReal : 0;
  const posTotal = Math.max(0, totalShares);
  const fmvFrac = posTotal > 0 ? Math.max(0, fundShares) / posTotal : costFrac;

  const cost = h.cost * costFrac;
  const real = h.real * realFrac;
  const fmv = h.fmv != null ? h.fmv * fmvFrac : null;
  const moic = fmv != null && cost > 0 ? (fmv + real) / cost : null;
  // The detail panel prefers these stored whole-asset override fields over the
  // ledger-derived figures, so scale them by the same fractions to keep the
  // expanded card consistent with the scoped row (share count follows the
  // market-value / net-share fraction). Per-share price stays as-is.
  const scale = (v: number | null | undefined, frac: number) => (v == null ? v : v * frac);
  return {
    ...h,
    cost,
    fmv,
    real,
    moic,
    inv: {
      ...inv,
      txns: scoped,
      _investedCapitalAmount: scale(inv._investedCapitalAmount, costFrac),
      _netDistributionAmount: scale(inv._netDistributionAmount, realFrac),
      _fmvAmount: scale(inv._fmvAmount, fmvFrac),
      _shareCount: scale(inv._shareCount, fmvFrac),
    },
  };
}

/** Display name for a holder. Appends parent group in parentheses when present. */
export function formatHolderName(
  holder: { n: string; groupName?: string | null } | { n: string },
): string {
  if ('groupName' in holder && holder.groupName) {
    return `${holder.n} (${holder.groupName})`;
  }
  return holder.n;
}

/** Formats the count of funds and entities holding positions. */
export function formatHolderCounts(fundCount: number, entityCount: number): string {
  const fundPart = `${fundCount} fund${fundCount === 1 ? '' : 's'}`;
  const entityPart = `${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}`;
  if (fundCount > 0 && entityCount > 0) {
    return `${fundPart} and ${entityPart}`;
  }
  if (entityCount > 0) {
    return entityPart;
  }
  return fundPart;
}

/** Adapts an Investor entity to a Fund shape so downstream functions expecting Fund don't crash. */
export function entityToFundAdapter(entity: Investor): Fund {
  const holdings = entity.holdings ?? [];
  const anyUnvalued =
    entity.valuationCoverage === 'partial' ||
    holdings.some((h) => h.fmv === null || h.valuationCoverage === 'partial');
  const holdingsFmv = holdings.reduce((s, h) => s + (h.fmv ?? 0), 0);
  const fmv = anyUnvalued
    ? null
    : entity.rawFmv != null
      ? (toDisplayMillions(entity.rawFmv) ?? null)
      : holdings.length > 0
        ? holdingsFmv
        : null;

  return {
    id: entity.id,
    n: entity.n,
    englishName: entity.englishName,
    legalName: entity.legalName,
    v: 0,
    size: 0,
    called: 0,
    calledPct: 0,
    fmv,
    real: entity.rawReal != null ? (toDisplayMillions(entity.rawReal) ?? 0) : 0,
    dpi: 0,
    tvpi: null,
    irr: 0,
    st: 'Active',
    h: holdings,
    valuationCoverage: entity.valuationCoverage,
  };
}

/** Returns the position ID(s) associated with a holding. */
export function getPositionKeys(h: Holding): string[] {
  const keys: string[] = [];
  if (h.positionId) keys.push(h.positionId);
  if (h.positionIds) {
    for (const pid of h.positionIds) {
      if (!keys.includes(pid)) keys.push(pid);
    }
  }
  return keys;
}

/** One holder's share of a whole-asset row: what that fund/entity invested,
 * and which of its positions that figure covers. */
export interface AssetHolderInvested {
  holderId: string;
  name: string;
  /** `'entity'` is an investor-held position (e.g. Startech). */
  kind: AssetHolderIdentity['kind'];
  /** The holder's summed scoped `cost` — the same figures `mergeScopedCopies`
   * adds into the row's Invested, so the breakdown reconciles to it. */
  invested: number;
  positionIds: string[];
}

/** One ungrouped Asset-tab row: the whole asset rebuilt from its per-fund
 * and per-entity scoped copies, plus every holder (largest invested share first). */
export interface WholeAssetRow {
  /** Stable row key — the holding/asset id when present (shared copies collapse
   * onto it), else the copy's fund/entity-scoped position key. */
  key: string;
  h: Holding;
  funds: Fund[];
  holders?: AssetHolderIdentity[];
  holderNames?: string[];
  /** Per-holder Invested, one entry per distinct holder (a holder with several
   * positions in the asset is summed), largest first. Sums to `h.cost`. */
  holderBreakdown: AssetHolderInvested[];
}

/** Folds an asset's (already deduplicated) scoped copies into one entry per
 * holder, preserving first-seen order, then stable-sorts by invested desc. */
function buildHolderBreakdown(
  copies: { h: Holding; holder: AssetHolderIdentity }[],
): AssetHolderInvested[] {
  const byHolder = new Map<string, AssetHolderInvested>();
  copies.forEach(({ h, holder }) => {
    const mapKey = `${holder.kind}:${holder.id}`;
    const existing = byHolder.get(mapKey);
    const positionIds = getPositionKeys(h);
    if (existing) {
      existing.invested += h.cost;
      positionIds.forEach((pid) => {
        if (!existing.positionIds.includes(pid)) existing.positionIds.push(pid);
      });
    } else {
      byHolder.set(mapKey, {
        holderId: holder.id,
        name: holder.name,
        kind: holder.kind,
        invested: h.cost,
        positionIds,
      });
    }
  });
  return [...byHolder.values()].sort((a, b) => b.invested - a.invested);
}

/** Inverse of `scopeHoldingToFund` for one asset's scoped copies: re-sums the
 * split invested / realized / market values (and the scaled stored override
 * fields) and re-concatenates the per-fund ledgers, so the merged holding
 * carries the whole-asset numbers again. `copies[0]` supplies every unscoped
 * field. */
function mergeScopedCopies(copies: Holding[]): Holding {
  const base = copies[0];
  let cost = 0;
  let fmv = 0;
  let real = 0;
  let anyUnvalued = false;
  copies.forEach((c) => {
    cost += c.cost;
    if (c.fmv != null) {
      fmv += c.fmv;
    } else {
      anyUnvalued = true;
    }
    real += c.real;
    if (c.valuationMethod === null && c.fmv === null) {
      anyUnvalued = true;
    }
  });
  const sumField = (pick: (i: Inv) => number | null | undefined): number | undefined => {
    let any = false;
    let s = 0;
    copies.forEach((c) => {
      const v = c.inv ? pick(c.inv) : null;
      if (v != null) {
        any = true;
        s += v;
      }
    });
    return any ? s : undefined;
  };
  return {
    ...base,
    cost,
    fmv: anyUnvalued ? null : fmv,
    real,
    moic: anyUnvalued || cost <= 0 ? null : (fmv + real) / cost,
    valuationMethod: anyUnvalued ? null : base.valuationMethod,
    valuationCoverage: anyUnvalued ? 'partial' : 'complete',
    inv: base.inv
      ? {
          ...base.inv,
          txns: copies
            .flatMap((c) => c.inv?.txns ?? [])
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
          _investedCapitalAmount: sumField((i) => i._investedCapitalAmount),
          _netDistributionAmount: sumField((i) => i._netDistributionAmount),
          _fmvAmount: sumField((i) => i._fmvAmount),
          _shareCount: sumField((i) => i._shareCount),
        }
      : base.inv,
  };
}

/**
 * Whole-asset rows for the Asset tab's ungrouped view. Fund membership is
 * transaction-driven, so a co-invested asset arrives once per fund/entity — each copy
 * scoped to that holder's share (see `scopeHoldingToFund`); left unmerged, the
 * same asset lists once per holder. Copies sharing a holding/asset id are summed
 * back into a single whole-asset holding. Holdings without a server id can't
 * be shared across funds and pass through untouched.
 * Positions are deduplicated by positionId so the same position is never double-counted.
 */
export function mergeHoldingsAcrossFunds(
  funds: Fund[],
  entities?: Investor[],
): WholeAssetRow[] {
  const order: string[] = [];
  const groups = new Map<string, { h: Holding; holder: AssetHolderIdentity }[]>();
  const seenPositions = new Set<string>();
  const seenHoldingObjects = new Set<Holding>();

  const addHolding = (h: Holding, hi: number, holder: AssetHolderIdentity) => {
    if (!h.displayOnly) {
      const posKeys = getPositionKeys(h);
      if (posKeys.length > 0) {
        if (posKeys.some((pk) => seenPositions.has(pk))) return;
        posKeys.forEach((pk) => seenPositions.add(pk));
      } else {
        if (seenHoldingObjects.has(h)) return;
        seenHoldingObjects.add(h);
      }
    } else {
      if (seenHoldingObjects.has(h)) return;
      seenHoldingObjects.add(h);
    }

    const key = h.displayOnly
      ? `displayOnly:${holder.id}:${h.id ?? hi}:${order.length}`
      : (h.id ?? `${holder.id}_${hi}`);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push({ h, holder });
  };

  funds.forEach((f) => {
    const holder: AssetHolderIdentity = {
      id: f.id,
      name: f.n,
      rawName: f.n,
      kind: 'fund',
      fund: f,
    };
    f.h.forEach((h, hi) => addHolding(h, hi, holder));
  });

  (entities ?? []).forEach((e) => {
    const holder: AssetHolderIdentity = {
      id: e.id,
      name: formatHolderName(e),
      rawName: e.n,
      kind: 'entity',
      groupName: e.groupName ?? null,
      investor: e,
    };
    (e.holdings ?? []).forEach((h, hi) => addHolding(h, hi, holder));
  });

  return order.map((key) => {
    const copies = groups.get(key)!;
    if (copies.length === 1) {
      const c = copies[0];
      return {
        key,
        h: c.h,
        funds: c.holder.kind === 'fund' && c.holder.fund ? [c.holder.fund] : [],
        holders: [c.holder],
        holderNames: [c.holder.name],
        holderBreakdown: buildHolderBreakdown(copies),
      };
    }
    const sorted = [...copies].sort((a, b) => b.h.cost - a.h.cost);
    const sortedHolders = sorted.map((c) => c.holder);
    const sortedFunds = sorted
      .filter((c) => c.holder.kind === 'fund' && c.holder.fund)
      .map((c) => c.holder.fund!);
    return {
      key,
      h: mergeScopedCopies(sorted.map((c) => c.h)),
      funds: sortedFunds,
      holders: sortedHolders,
      holderNames: sortedHolders.map((hd) => hd.name),
      holderBreakdown: buildHolderBreakdown(sorted),
    };
  });
}

export const mergeHoldingsAcrossHolders = mergeHoldingsAcrossFunds;

/** Roll a set of transaction-level slices up into a single aggregate row. */
export function sumSlices(items: { cost: number; fmv: number | null; real: number }[]): SourceAgg {
  let cost = 0;
  let fmv = 0;
  let real = 0;
  let anyUnvalued = false;
  items.forEach((it) => {
    cost += it.cost;
    if (it.fmv != null) {
      fmv += it.fmv;
    } else {
      anyUnvalued = true;
    }
    real += it.real;
  });
  const valuationCoverage: ValuationCoverage = anyUnvalued ? 'partial' : 'complete';
  const gain = valuationCoverage === 'partial' ? null : fmv + real - cost;
  return {
    cost,
    fmv,
    real,
    gain,
    moic: valuationCoverage === 'partial' || cost <= 0 ? null : (fmv + real) / cost,
    count: items.length,
    valuationCoverage,
  };
}

/**
 * Transaction-level aggregate keyed by an arbitrary dimension. `keyFor` maps a
 * transaction to its bucket; `assetKeys` supplies the fallback bucket(s) for
 * holdings with no ledger (or no transactions), so their manual amounts still
 * land somewhere sensible. `count` is the number of holdings touching a bucket.
 */
export function aggregateByTxn(
  funds: Fund[],
  keyFor: (t: Txn, h: Holding, f: Fund) => string,
  assetKeys: (h: Holding, f: Fund) => string[],
): Map<string, SourceAgg> {
  const out = new Map<
    string,
    { cost: number; fmv: number; real: number; anyUnvalued: boolean; count: number }
  >();
  const ensure = (k: string) => {
    let a = out.get(k);
    if (!a) {
      a = { cost: 0, fmv: 0, real: 0, anyUnvalued: false, count: 0 };
      out.set(k, a);
    }
    return a;
  };

  funds.forEach((f) => {
    f.h.forEach((h) => {
      const split = splitHoldingByTxn(h, f, keyFor);
      if (split === null || split.size === 0) {
        // Ledger-less holding, or a ledger holding with no transactions: pin the
        // whole-asset numbers to its asset-level bucket(s).
        assetKeys(h, f).forEach((k) => {
          const a = ensure(k);
          a.cost += h.cost;
          if (h.fmv != null) {
            a.fmv += h.fmv;
          } else {
            a.anyUnvalued = true;
          }
          a.real += h.real;
          a.count += 1;
        });
        return;
      }
      split.forEach((s, k) => {
        const a = ensure(k);
        a.cost += s.cost;
        if (s.fmv != null) {
          a.fmv += s.fmv;
        } else {
          a.anyUnvalued = true;
        }
        a.real += s.real;
        a.count += 1;
      });
    });
  });

  const res = new Map<string, SourceAgg>();
  out.forEach((a, k) => {
    const valuationCoverage: ValuationCoverage = a.anyUnvalued ? 'partial' : 'complete';
    const gain = valuationCoverage === 'partial' ? null : a.fmv + a.real - a.cost;
    const moic = valuationCoverage === 'partial' || a.cost <= 0 ? null : (a.fmv + a.real) / a.cost;
    res.set(k, {
      cost: a.cost,
      fmv: a.fmv,
      real: a.real,
      gain,
      moic,
      count: a.count,
      valuationCoverage,
    });
  });
  return res;
}

/** A holding as it appears inside one transaction-level group, carrying only
 * that group's slice of the holding's Invested / Realized / market value. */
export interface HoldingSlice extends SourceHolding {
  cost: number;
  fmv: number | null;
  real: number;
  moic: number | null;
  holderNames?: string[];
}

/**
 * Group holdings for the Asset tab's transaction-level views: a holding is split
 * across every bucket its ledger touches, so the same asset can appear under
 * several groups, each showing only its own slice.
 * Accepts optional entities array so investor-held holdings are included and deduplicated.
 */
export function sliceHoldingsByTxn(
  funds: Fund[],
  keyFor: (t: Txn, h: Holding, f: Fund) => string,
  assetKeys: (h: Holding, f: Fund) => string[],
  entities?: Investor[],
): Map<string, HoldingSlice[]> {
  const map = new Map<string, HoldingSlice[]>();
  const push = (key: string, slice: HoldingSlice) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(slice);
  };

  const seenPositions = new Set<string>();
  const seenHoldingObjects = new Set<Holding>();

  const processHolder = (holderId: string, holdings: Holding[], f: Fund, holderLabel: string) => {
    holdings.forEach((h, hi) => {
      if (h.displayOnly) return;
      const posKeys = getPositionKeys(h);
      if (posKeys.length > 0) {
        if (posKeys.some((pk) => seenPositions.has(pk))) return;
        posKeys.forEach((pk) => seenPositions.add(pk));
      } else {
        if (seenHoldingObjects.has(h)) return;
        seenHoldingObjects.add(h);
      }

      const base: SourceHolding = { h, f, hkey: `${holderId}_${hi}` };
      const split = splitHoldingByTxn(h, f, keyFor);
      if (split === null || split.size === 0) {
        assetKeys(h, f).forEach((key) =>
          push(key, {
            ...base,
            cost: h.cost,
            fmv: h.fmv,
            real: h.real,
            moic: h.moic,
            holderNames: [holderLabel],
          }),
        );
        return;
      }
      split.forEach((s, key) => {
        push(key, {
          ...base,
          cost: s.cost,
          fmv: s.fmv,
          real: s.real,
          moic: s.fmv != null && s.cost > 0 ? (s.fmv + s.real) / s.cost : null,
          holderNames: [holderLabel],
        });
      });
    });
  };

  funds.forEach((f) => {
    if (f.displayOnly) return;
    processHolder(f.id, f.h, f, f.n);
  });

  (entities ?? []).forEach((e) => {
    const f = entityToFundAdapter(e);
    processHolder(e.id, e.holdings ?? [], f, formatHolderName(e));
  });

  return map;
}

/**
 * Portfolio totals summed from the holdings themselves (not fund-level rollup
 * fields), so the header cards reconcile with every grouping — including assets
 * under the synthetic "Unassigned Assets" fund, whose fund-level rollups read 0,
 * as well as direct investor/entity-held positions.
 * Commitment and the trailing-quarter history stay fund-level.
 */
export function holdingsPortfolioTotals(
  funds: Fund[],
  entities?: Investor[],
): PortfolioTotals {
  let invested = 0;
  let holdingFmv = 0;
  let anyValued = false;
  let real = 0;
  let anyUnvalued = false;

  const seenPositions = new Set<string>();
  const seenHoldingObjects = new Set<Holding>();

  const processHolding = (h: Holding) => {
    if (h.displayOnly) return;
    const posKeys = getPositionKeys(h);
    if (posKeys.length > 0) {
      if (posKeys.some((pk) => seenPositions.has(pk))) return;
      posKeys.forEach((pk) => seenPositions.add(pk));
    } else {
      if (seenHoldingObjects.has(h)) return;
      seenHoldingObjects.add(h);
    }

    invested += h.cost;
    if (h.fmv != null) {
      holdingFmv += h.fmv;
      anyValued = true;
    } else {
      anyUnvalued = true;
    }
    real += h.real;
    if (h.valuationMethod === null && h.fmv === null) {
      anyUnvalued = true;
    }
    if (h.valuationCoverage === 'partial') {
      anyUnvalued = true;
    }
  };

  funds.forEach((f) => {
    if (f.displayOnly) return;
    f.h.forEach(processHolding);
    if (f.valuationCoverage === 'partial') {
      anyUnvalued = true;
    }
  });

  (entities ?? []).forEach((e) => {
    (e.holdings ?? []).forEach(processHolding);
    if (e.valuationCoverage === 'partial') {
      anyUnvalued = true;
    }
  });
  const valuationCoverage: ValuationCoverage = anyUnvalued ? 'partial' : 'complete';
  const commitment = funds.filter((f) => !f.displayOnly).reduce((s, f) => s + f.size, 0);
  const committedHist = sumHist(funds, 'committed');
  const calledHist = sumHist(funds, 'called');
  const fmvHist = sumHist(funds, 'fmv');
  const tvpiHist = QLABELS.map((_, qi) => {
    const fmvVal = fmvHist[qi];
    if (fmvVal === null) return null;
    for (const f of funds) {
      if (f.displayOnly) continue;
      if (f.hist?.tvpi && f.hist.tvpi[qi] === null) {
        return null;
      }
    }
    const c = calledHist[qi];
    if (c === null) return null;
    if (qi === QLABELS.length - 1) {
      return c ? (fmvVal + real) / c : 0;
    }
    const nonDisplayFunds = funds.filter((f) => !f.displayOnly);
    if (nonDisplayFunds.length === 1 && nonDisplayFunds[0].hist?.tvpi?.[qi] != null) {
      return nonDisplayFunds[0].hist.tvpi[qi];
    }
    if (real === 0) {
      return c ? fmvVal / c : 0;
    }
    return null;
  });

  // Unrealized MV is holdings-only: cash (and its FX status) never enters it or MOIC.
  const fmv = anyValued ? holdingFmv : null;
  const moic = valuationCoverage === 'partial' || !invested || fmv === null ? null : (fmv + real) / invested;

  return {
    commitment,
    invested,
    fmv,
    real,
    moic,
    valuationCoverage,
    committedHist,
    calledHist,
    fmvHist,
    tvpiHist,
  };
}

// Keep a holding's roll-up fields consistent with its ledger after an edit.
export function applyHoldingMetrics(h: Holding) {
  const effectiveAsOf = (h.asOfDate || h.inv?.asOfDate) || undefined;
  if (isValueBased(h)) {
    const c = computeFoF(h, effectiveAsOf);
    if (!c) return;
    h.cost = c.costInv;
    h.fmv = c.marketValue;
    h.real = c.netDist;
    h.moic = c.moic;
  } else {
    const c = computeInv(h, effectiveAsOf);
    if (!c) return;
    h.cost = c.investedCapital;
    h.fmv = c.unrealizedValue;
    h.real = c.realizedProceedsGross;
    h.moic = c.grossMOIC;
  }
  h.valuationCoverage = h.fmv != null ? 'complete' : 'partial';
}

// Roll a fund's totals up from its holdings after one of them changed.
export function recomputeFund(f: Fund) {
  const activeHoldings = f.h.filter((x) => !x.displayOnly);
  const hasUnvalued = activeHoldings.some((x) => x.fmv === null || x.valuationMethod === null);
  f.valuationCoverage = hasUnvalued ? 'partial' : 'complete';
  let totalRealDistributed = 0;
  let hasDetailedTxns = false;

  for (const h of activeHoldings) {
    const txns = h.inv?.txns ?? [];
    if (txns.length > 0) {
      hasDetailedTxns = true;
      for (const t of txns) {
        const isSell =
          t.type === 'Sell' ||
          t.entryType === 'sell' ||
          t.entryType === 'redemption' ||
          t.entryType === 'distribution';
        const isRealized =
          isSell ||
          t.label === 'Interest income' ||
          t.label === 'Return of capital' ||
          t.label === 'Dividend';
        if (isRealized) {
          const isRetained =
            t.sellProceedsDestination === 'cash_in_fund' ||
            t.label === SUB_TYPE_DIVESTMENT_CASH_IN_FUND ||
            t.label === 'cash_in_fund';
          const val = t.value ?? (t.pps != null && t.shares != null ? t.pps * t.shares : 0);
          if (!isRetained) {
            totalRealDistributed += val;
          }
        }
      }
    }
  }

  const assetFmv = activeHoldings.reduce((s, x) => s + (x.fmv ?? 0), 0);
  // Unrealized MV is holdings-only; null ("—") until some holding is valued.
  f.fmv = activeHoldings.some((x) => x.fmv != null) ? assetFmv : null;
  // TVPI keeps NAV = holdings + cash, so it is unavailable while cash is pending FX.
  const navUnavailable =
    f.fxStatus === 'pending_fx' ||
    (f.reportingTotalAvailable === false && f.cashStatus !== 'incomplete_negative') ||
    f.rawNav === null;
  f.tvpi =
    navUnavailable || f.valuationCoverage === 'partial' || !f.called
      ? null
      : (assetFmv + (f.cashBalance ?? 0) + f.real) / f.called;
  f.real = hasDetailedTxns ? totalRealDistributed : activeHoldings.reduce((s, x) => s + x.real, 0);
  f.dpi = f.called ? f.real / f.called : 0;
  if (f.hist && f.hist.fmv.length) f.hist.fmv[f.hist.fmv.length - 1] = assetFmv;
}
