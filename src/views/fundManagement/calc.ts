// Pure calculation + formatting helpers for Fund Management, ported from the
// mockup so the numbers match exactly. No DOM, no side effects.

import type {
  EquityMetrics,
  FoFMetrics,
  Fund,
  Holding,
  Investor,
  Quarter,
} from './types';
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
export const money = (v: number) => '$' + formatCompact((v || 0) * 1e6);
export const money2 = (v: number) => '$' + v.toFixed(2);
// Fund-of-funds amounts are also stored in millions — same compact treatment
// (previously multiplied by 1000, which mis-scaled the display by 1000×).
export const moneyK = (v: number) => '$' + formatCompact((v || 0) * 1e6);
export const moneyFee = (vM: number) => '$' + formatCompact(Math.abs((vM || 0) * 1e6));

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

export function txnTypeLabel(t: { type: string; label?: string }, h: Holding) {
  if (h.tp === 'Cash') {
    return (
      ({ Buy: 'Deposit', Distribution: 'Distribution', Other: t.label || 'Interest / adjustment' } as Record<
        string,
        string
      >)[t.type] || t.type
    );
  }
  if (isFoF(h)) {
    return (
      ({ Buy: 'Capital call', Distribution: 'Distribution', Other: t.label || 'Other' } as Record<
        string,
        string
      >)[t.type] || t.type
    );
  }
  return (
    ({
      Buy: 'Purchase',
      Sell: 'Divestment',
      Distribution: 'Distribution',
      Other: t.label || 'Other',
    } as Record<string, string>)[t.type] || t.type
  );
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
  const dists = txns.filter((t) => t.type === 'Distribution');
  const others = txns.filter((t) => t.type === 'Other');

  const investedCapital = buys.reduce((s, t) => s + (txnValue(t) ?? 0), 0);
  const realizedProceedsGross =
    sells.reduce((s, t) => s + (txnValue(t) ?? 0), 0) +
    dists.reduce((s, t) => s + (t.value || 0), 0);
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
  const dists = txns.filter((t) => t.type === 'Distribution');
  const others = txns.filter((t) => t.type === 'Other');
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

export interface InvestorAgg {
  commit: number;
  called: number;
  value: number;
  real: number;
  gain: number;
  moic: number;
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

export function investorInvestedFromTxns(entityId: string, funds: Fund[]): number {
  return funds.reduce((sum, f) => sum + investorInvestedInFund(entityId, f), 0);
}

export function investorAgg(inv: Investor, funds: Fund[]): InvestorAgg {
  let commit = 0;
  let value = 0;
  let real = 0;
  funds.forEach((f) => {
    const s = inv.stakes[f.id] || 0;
    commit += f.size * s;
    value += f.fmv * s;
    real += f.real * s;
  });
  // Invested comes from this entity's own transactions, not a pro-rata slice.
  const called = investorInvestedFromTxns(inv.id, funds);
  return { commit, called, value, real, gain: value + real - called, moic: called > 0 ? (value + real) / called : 0 };
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
/** Group every holding by its source(s) of fund; a holding can appear in several. */
export function collectHoldingsBySource(funds: Fund[]): Map<string, SourceHolding[]> {
  const map = new Map<string, SourceHolding[]>();
  funds.forEach((f) => {
    f.h.forEach((h, hi) => {
      const item: SourceHolding = { h, f, hkey: `${f.id}_${hi}` };
      getAssetFundingSources(h).forEach((src) => {
        if (!map.has(src)) map.set(src, []);
        map.get(src)!.push(item);
      });
    });
  });
  return map;
}

// ---- investment-entity aggregates ----
/** The investing entity a holding belongs to (type_details.investingEntity). */
export function getAssetEntity(h: Holding): string | null {
  const raw = ((h.inv && h.inv.entity) || (h.d && h.d.entity) || '').trim();
  return raw || null;
}

/**
 * Group every holding by its investing entity. Entities in `knownEntities`
 * always get a bucket (even if empty); any holding whose entity is blank or
 * not in that list falls into "Others". Mirrors collectHoldingsBySource.
 */
export function collectHoldingsByEntity(
  funds: Fund[],
  knownEntities: string[],
): Map<string, SourceHolding[]> {
  const OTHERS = 'Others';
  const known = new Set(knownEntities);
  const map = new Map<string, SourceHolding[]>();
  knownEntities.forEach((e) => map.set(e, []));
  map.set(OTHERS, []);
  funds.forEach((f) => {
    f.h.forEach((h, hi) => {
      const entity = getAssetEntity(h);
      const key = entity && known.has(entity) ? entity : OTHERS;
      map.get(key)!.push({ h, f, hkey: `${f.id}_${hi}` });
    });
  });
  return map;
}

/**
 * Generic holding grouper for the Asset tab. `keyFn` returns the bucket key(s)
 * a holding belongs to — one key for fund/entity grouping, several for source
 * of fund (a holding can be funded from more than one pool). Buckets preserve
 * first-seen insertion order; the caller sorts.
 */
export function groupHoldings(
  funds: Fund[],
  keyFn: (h: Holding, f: Fund) => string[],
): Map<string, SourceHolding[]> {
  const map = new Map<string, SourceHolding[]>();
  funds.forEach((f) => {
    f.h.forEach((h, hi) => {
      const item: SourceHolding = { h, f, hkey: `${f.id}_${hi}` };
      keyFn(h, f).forEach((key) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(item);
      });
    });
  });
  return map;
}

export interface SourceAgg {
  cost: number;
  fmv: number;
  real: number;
  gain: number;
  moic: number;
  count: number;
}
export function sourceAgg(items: SourceHolding[]): SourceAgg {
  let cost = 0;
  let fmv = 0;
  let real = 0;
  items.forEach(({ h }) => {
    cost += h.cost;
    fmv += h.fmv;
    real += h.real;
  });
  const gain = fmv + real - cost;
  return { cost, fmv, real, gain, moic: cost > 0 ? (fmv + real) / cost : 0, count: items.length };
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

