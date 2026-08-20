// Pure calculation + formatting helpers for Fund Management, ported from the
// mockup so the numbers match exactly. No DOM, no side effects.

import type {
  EquityMetrics,
  FoFMetrics,
  Fund,
  Holding,
  Inv,
  Investor,
  Quarter,
  Txn,
  TxnType,
} from './types';
import type { SellProceedsDestination } from '@/lib/sellProceedsDestination';
import { quarterEndLabel, trailingQuarterEnds } from './adapters';

// The 4 trailing completed quarters as of "now" — real labels for real
// fund.hist data (computeFundHistory), not the mockup's 4 hardcoded strings.
export const QLABELS = trailingQuarterEnds(4).map(quarterEndLabel);
export const INVEST_TYPES = ['Direct Investment', 'Fund of Funds', 'Others'];

// ---- number formatting (pure; shared with CurrencyInput) ----
/** Strips a trailing `.0`/`.00` from a fixed-precision string. */
function trimZeros(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * Apply thousand-separator commas to a raw numeric string in-place.
 * Preserves a leading minus sign, a trailing decimal point, and any
 * digits after the decimal. Used for real-time input formatting where
 * the value has already had commas stripped.
 */
export function applyCommas(s: string): string {
  if (!s) return s;
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const dotIdx = abs.indexOf('.');
  const intStr = dotIdx >= 0 ? abs.slice(0, dotIdx) : abs;
  const decStr = dotIdx >= 0 ? abs.slice(dotIdx) : '';
  return (neg ? '-' : '') + intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + decStr;
}

/** `2000 -> "2,000"`, `1234.5 -> "1,234.5"`. Groups the integer part only. */
export function formatGrouped(n: number): string {
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const [intPart, decPart] = Math.abs(n).toString().split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${decPart ? `.${decPart}` : ''}`;
}

/** `2000000 -> "2M"`, `2500 -> "2.5k"`, `1.5e9 -> "1.5B"`, `500 -> "500"`. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${trimZeros((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}${trimZeros((abs / 1e6).toFixed(2))}M`;
  if (abs >= 1e3) return `${sign}${trimZeros((abs / 1e3).toFixed(2))}k`;
  return `${sign}${trimZeros(abs.toFixed(2))}`;
}

/** Parses grouped/compact user input back to a number. Accepts commas and a
 * trailing k/m/b suffix so re-editing a compacted value round-trips. */
export function parseCurrencyInput(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (s === '') return null;
  const m = s.match(/^(-?\d*\.?\d+)\s*([kKmMbB]?)$/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1;
  return base * mult;
}

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
  const en = h.englishName?.trim();
  if (!en || en === name.trim()) return name;
  return `${name} (${en})`;
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

function isGeneratedCashMovement(t: Txn): boolean {
  return Boolean(t.isGenerated || t.sourceDivestmentTxnId);
}

export function txnTypeLabel(
  t: {
    type: string;
    label?: string;
    isGenerated?: boolean;
    sourceDivestmentTxnId?: string | null;
    sellProceedsDestination?: SellProceedsDestination | null;
  },
  h: Holding,
) {
  if (t.isGenerated || t.sourceDivestmentTxnId || t.label === 'Retained sale proceeds') {
    return 'Retained sale proceeds';
  }
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

// ---- equity metrics ----
export function computeInv(h: Holding): EquityMetrics | null {
  const inv = h.inv;
  if (!inv) return null;
  const txns = inv.txns || [];
  const buys = txns.filter((t) => t.type === 'Buy');
  const sells = txns.filter((t) => t.type === 'Sell');
  const others = txns.filter((t) => t.type === 'Other');

  const investedCapital = buys.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const realizedProceedsGross = sells.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const otherVal = others.reduce((s, t) => s + (t.value || 0), 0);
  const divestment = sells.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const sharesAcquired = buys.reduce((s, t) => s + (t.shares || 0), 0);
  const sharesDisposed = sells.reduce((s, t) => s + (t.shares || 0), 0);
  const sharesHeld = sharesAcquired - sharesDisposed;
  const blendedEntryPrice = sharesAcquired ? investedCapital / sharesAcquired : 0;
  const curPrice = inv._cur != null ? inv._cur : sharesHeld ? h.fmv / sharesHeld : 0;
  // When the ledger has share counts, unrealized value is shares × price.
  // Otherwise (value-only positions, like most seed rows) fall back to the
  // latest quarterly mark so metrics stay meaningful and edits aren't zeroed.
  const latestMv =
    inv.quarterly && inv.quarterly.length ? inv.quarterly[inv.quarterly.length - 1].mv : null;
  const unrealizedValue = sharesHeld
    ? sharesHeld * curPrice
    : latestMv != null
      ? latestMv
      : h.fmv || 0;
  const totalValueGross = realizedProceedsGross + otherVal + unrealizedValue;
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

  const totalGrossGain = totalValueGross - investedCapital;
  const carryOwed = Math.max(0, totalGrossGain) * carryRate;
  const netTotalValue = totalValueGross - carryOwed;

  const mgmtFeeVal = cumulativeMgmtFees;
  const prefReturnVal = investedCapital * prefReturnRate * holdYrs;
  const carryVal = carryOwed;
  const totalFeesVal = -(mgmtFeeVal + carryVal);

  const grossMOIC = investedCapital ? totalValueGross / investedCapital : 0;
  const netMOIC = allInCostBasis ? netTotalValue / allInCostBasis : 0;
  const dpi = investedCapital ? realizedProceedsGross / investedCapital : 0;
  const unreal = blendedEntryPrice ? (curPrice - blendedEntryPrice) / blendedEntryPrice : 0;
  const grossIRR =
    investedCapital && holdYrs
      ? Math.pow(totalValueGross / investedCapital, 1 / Math.max(holdYrs, 0.5)) - 1
      : 0;
  const netIRR =
    allInCostBasis && holdYrs
      ? Math.pow(netTotalValue / allInCostBasis, 1 / Math.max(holdYrs, 0.5)) - 1
      : 0;

  let quarterly: Quarter[];
  if (inv.quarterly && inv.quarterly.length) {
    quarterly = inv.quarterly;
  } else {
    const factors = [0.86, 0.91, 0.96, 1.0];
    quarterly = QLABELS.map((q, i) => {
      const pps = curPrice * factors[i];
      return {
        q,
        pps,
        mv: sharesHeld * pps,
        cost: investedCapital,
        sharesOut: null,
        shPct: null,
        moic: null,
        xirr: null,
        notes: null,
      };
    });
  }

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
    carryVal,
    totalFeesVal,
    totalGrossGain,
    carryOwed,
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
    quarterly,
  };
}

// ---- fund-of-funds metrics ----
export function computeFoF(h: Holding): FoFMetrics | null {
  const inv = h.inv;
  if (!inv) return null;
  const txns = inv.txns || [];
  const calls = txns.filter((t) => t.type === 'Buy');
  const dists = txns.filter((t) => t.type === 'Sell');
  const others = txns.filter(
    (t) =>
      t.type === 'Other' &&
      !isGeneratedCashMovement(t),
  );
  const totalCalled = calls.reduce((s, t) => s + (t.value || 0), 0);
  const totalDist = dists.reduce((s, t) => s + (t.value || 0), 0);
  const totalOther = others.reduce((s, t) => s + (t.value || 0), 0);
  const costInv = totalCalled;
  const latestQ =
    inv.quarterly && inv.quarterly.length ? inv.quarterly[inv.quarterly.length - 1] : null;
  const marketValue = latestQ && latestQ.mv != null ? latestQ.mv : h.fmv;
  const netDist = totalDist + totalOther;
  const moic = costInv ? (marketValue + netDist) / costInv : 0;
  const dpi = costInv ? netDist / costInv : 0;
  const years = inv.quarterly && inv.quarterly.length >= 2 ? inv.quarterly.length * 0.25 : 1;
  const xirr =
    costInv && years ? Math.pow((marketValue + netDist) / costInv, 1 / Math.max(years, 1)) - 1 : 0;
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
    const k = ABBR[x.tp] || x.tp;
    c[k] = (c[k] || 0) + 1;
  });
  return Object.entries(c)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
}

export function growth(arr: number[]) {
  const n = arr.length;
  if (n < 2) return 0;
  const c = arr[n - 1];
  const p = arr[n - 2];
  return p === 0 ? 0 : ((c - p) / p) * 100;
}

export function sumHist(funds: Fund[], key: keyof FundHistLike) {
  return QLABELS.map((_, qi) =>
    funds.reduce((s, f) => s + (f.hist && f.hist[key] ? f.hist[key][qi] : 0), 0),
  );
}
type FundHistLike = { committed: number[]; called: number[]; fmv: number[] };

export interface PortfolioTotals {
  commitment: number;
  invested: number;
  fmv: number;
  real: number;
  moic: number;
  committedHist: number[];
  calledHist: number[];
  fmvHist: number[];
  tvpiHist: number[];
}
export function portfolioTotals(funds: Fund[]): PortfolioTotals {
  const commitment = funds.reduce((s, f) => s + f.size, 0);
  const invested = funds.reduce((s, f) => s + f.called, 0);
  const fmv = funds.reduce((s, f) => s + f.fmv, 0);
  const real = funds.reduce((s, f) => s + f.real, 0);
  const committedHist = sumHist(funds, 'committed');
  const calledHist = sumHist(funds, 'called');
  const fmvHist = sumHist(funds, 'fmv');
  const tvpiHist = QLABELS.map((_, qi) => {
    const c = calledHist[qi];
    return c ? (fmvHist[qi] + real * (qi === QLABELS.length - 1 ? 1 : 0.85)) / c : 0;
  });
  return {
    commitment,
    invested,
    fmv,
    real,
    moic: invested ? (fmv + real) / invested : 0,
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
  let invested = 0;
  fund.h.forEach((h) => {
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
  gain: number;
  moic: number;
  count: number;
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
): Map<string, { cost: number; real: number; fmv: number }> | null {
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
      if (t.type === 'Buy') b.cost += t.value || 0;
      else if (
        t.type === 'Sell' ||
        (t.type === 'Other' && !isGeneratedCashMovement(t))
      ) {
        b.real += t.value || 0;
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

  const out = new Map<string, { cost: number; real: number; fmv: number }>();
  const keys = [...per.keys()];
  if (keys.length === 0) return out;
  const totalShares = keys.reduce((s, k) => s + Math.max(0, per.get(k)!.shares), 0);
  const totalCost = keys.reduce((s, k) => s + per.get(k)!.cost, 0);
  let allocated = 0;
  keys.forEach((k, i) => {
    const b = per.get(k)!;
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
 * its ledger names (see FundAssetRepository.findByFundId), so a co-invested
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
      } else if (
        t.type === 'Sell' ||
        (t.type === 'Other' && !isGeneratedCashMovement(t))
      ) {
        totalReal += t.value || 0;
        if (mine) fundReal += t.value || 0;
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
  const fmv = h.fmv * fmvFrac;
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
    moic: cost > 0 ? (fmv + real) / cost : 0,
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

/** One ungrouped Asset-tab row: the whole asset rebuilt from its per-fund
 * scoped copies, plus every fund holding it (largest invested share first). */
export interface WholeAssetRow {
  /** Stable row key — the fund_assets id when present (shared copies collapse
   * onto it), else the copy's fund-scoped position key. */
  key: string;
  h: Holding;
  funds: Fund[];
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
  copies.forEach((c) => {
    cost += c.cost;
    fmv += c.fmv;
    real += c.real;
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
    fmv,
    real,
    moic: cost > 0 ? (fmv + real) / cost : 0,
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
 * transaction-driven, so a co-invested asset arrives once per fund — each copy
 * scoped to that fund's share (see `scopeHoldingToFund`); left unmerged, the
 * same asset lists once per fund. Copies sharing a fund_assets id are summed
 * back into a single whole-asset holding. Holdings without a server id can't
 * be shared across funds and pass through untouched.
 */
export function mergeHoldingsAcrossFunds(funds: Fund[]): WholeAssetRow[] {
  const order: string[] = [];
  const groups = new Map<string, { h: Holding; f: Fund }[]>();
  funds.forEach((f) => {
    f.h.forEach((h, hi) => {
      const key = h.id ?? `${f.id}_${hi}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push({ h, f });
    });
  });
  return order.map((key) => {
    const copies = groups.get(key)!;
    if (copies.length === 1) return { key, h: copies[0].h, funds: [copies[0].f] };
    const sorted = [...copies].sort((a, b) => b.h.cost - a.h.cost);
    return {
      key,
      h: mergeScopedCopies(sorted.map((c) => c.h)),
      funds: sorted.map((c) => c.f),
    };
  });
}

/** Roll a set of transaction-level slices up into a single aggregate row. */
export function sumSlices(items: { cost: number; fmv: number; real: number }[]): SourceAgg {
  let cost = 0;
  let fmv = 0;
  let real = 0;
  items.forEach((it) => {
    cost += it.cost;
    fmv += it.fmv;
    real += it.real;
  });
  const gain = fmv + real - cost;
  return { cost, fmv, real, gain, moic: cost > 0 ? (fmv + real) / cost : 0, count: items.length };
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
  const out = new Map<string, SourceAgg>();
  const ensure = (k: string): SourceAgg => {
    let a = out.get(k);
    if (!a) {
      a = { cost: 0, fmv: 0, real: 0, gain: 0, moic: 0, count: 0 };
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
          a.fmv += h.fmv;
          a.real += h.real;
          a.count += 1;
        });
        return;
      }
      split.forEach((s, k) => {
        const a = ensure(k);
        a.cost += s.cost;
        a.fmv += s.fmv;
        a.real += s.real;
        a.count += 1;
      });
    });
  });

  out.forEach((a) => {
    a.gain = a.fmv + a.real - a.cost;
    a.moic = a.cost > 0 ? (a.fmv + a.real) / a.cost : 0;
  });
  return out;
}

/** A holding as it appears inside one transaction-level group, carrying only
 * that group's slice of the holding's Invested / Realized / market value. */
export interface HoldingSlice extends SourceHolding {
  cost: number;
  fmv: number;
  real: number;
  moic: number;
}

/**
 * Group holdings for the Asset tab's transaction-level views: a holding is split
 * across every bucket its ledger touches, so the same asset can appear under
 * several groups, each showing only its own slice.
 */
export function sliceHoldingsByTxn(
  funds: Fund[],
  keyFor: (t: Txn, h: Holding, f: Fund) => string,
  assetKeys: (h: Holding, f: Fund) => string[],
): Map<string, HoldingSlice[]> {
  const map = new Map<string, HoldingSlice[]>();
  const push = (key: string, slice: HoldingSlice) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(slice);
  };

  funds.forEach((f) => {
    f.h.forEach((h, hi) => {
      const base: SourceHolding = { h, f, hkey: `${f.id}_${hi}` };
      const split = splitHoldingByTxn(h, f, keyFor);
      if (split === null || split.size === 0) {
        assetKeys(h, f).forEach((key) =>
          push(key, { ...base, cost: h.cost, fmv: h.fmv, real: h.real, moic: h.moic }),
        );
        return;
      }
      split.forEach((s, key) => {
        push(key, {
          ...base,
          cost: s.cost,
          fmv: s.fmv,
          real: s.real,
          moic: s.cost > 0 ? (s.fmv + s.real) / s.cost : 0,
        });
      });
    });
  });
  return map;
}

/**
 * Portfolio totals summed from the holdings themselves (not fund-level rollup
 * fields), so the header cards reconcile with every grouping — including assets
 * under the synthetic "Unassigned Assets" fund, whose fund-level rollups read 0.
 * Commitment and the trailing-quarter history stay fund-level.
 */
export function holdingsPortfolioTotals(funds: Fund[]): PortfolioTotals {
  let invested = 0;
  let fmv = 0;
  let real = 0;
  funds.forEach((f) => {
    f.h.forEach((h) => {
      invested += h.cost;
      fmv += h.fmv;
      real += h.real;
    });
  });
  const commitment = funds.reduce((s, f) => s + f.size, 0);
  const committedHist = sumHist(funds, 'committed');
  const calledHist = sumHist(funds, 'called');
  const fmvHist = sumHist(funds, 'fmv');
  const tvpiHist = QLABELS.map((_, qi) => {
    const c = calledHist[qi];
    return c ? (fmvHist[qi] + real * (qi === QLABELS.length - 1 ? 1 : 0.85)) / c : 0;
  });
  return {
    commitment,
    invested,
    fmv,
    real,
    moic: invested ? (fmv + real) / invested : 0,
    committedHist,
    calledHist,
    fmvHist,
    tvpiHist,
  };
}

// Keep a holding's roll-up fields consistent with its ledger after an edit.
export function applyHoldingMetrics(h: Holding) {
  if (isValueBased(h)) {
    const c = computeFoF(h);
    if (!c) return;
    h.cost = c.costInv;
    h.fmv = c.marketValue;
    h.real = c.netDist;
    h.moic = c.moic;
  } else {
    const c = computeInv(h);
    if (!c) return;
    h.cost = c.investedCapital;
    h.fmv = c.unrealizedValue;
    h.real = c.realizedProceedsGross;
    h.moic = c.investedCapital ? c.totalValueGross / c.investedCapital : h.moic || 1;
  }
}

// Roll a fund's totals up from its holdings after one of them changed.
export function recomputeFund(f: Fund) {
  f.fmv = f.h.reduce((s, x) => s + x.fmv, 0);
  f.real = f.h.reduce((s, x) => s + x.real, 0);
  f.tvpi = f.called ? (f.fmv + f.real) / f.called : 0;
  f.dpi = f.called ? f.real / f.called : 0;
  if (f.hist && f.hist.fmv.length) f.hist.fmv[f.hist.fmv.length - 1] = f.fmv;
}
