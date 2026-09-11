import { isPaidInAdjustment, paidInAdjustmentDelta } from '@/lib/fundLedger/paidInAdjustment';
// Explicit field-by-field mapping between backend rows (v2 Fund Ledger
// /api/fund-ledger) and the UI's domain types (./types.ts).
// Kept as one file so a dropped/renamed field on either side is easy to spot.

import type { Tables } from '@/lib/repositories';
import type {
  EntryType,
  FlPortfolioLedgerEntry,
  FlPortfolioPosition,
  LedgerEntryInput,
  RecordValuationInput,
} from '@/lib/api/fundLedger';
import {
  flAbs,
  flAdd,
  flDiv,
  flGt,
  flIsZero,
  flMul,
  flNeg,
  flSub,
  flSum,
  toDecimalString,
} from '@/lib/services/flDecimal';
import type {
  DisclosureReason,
  Fund,
  FundExposure,
  FundHist,
  Holding,
  HoldingFacts,
  HoldingType,
  Inv,
  Investor,
  Quarter,
  SellProceedsDestination,
  Txn,
  TxnType,
  ValuationCoverage,
} from './types';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  toDivestmentSubType,
} from '@/lib/sellProceedsDestination';
import {
  computeFundCashSummary,
  type FundCashSummary,
} from '@/lib/fundLedger/fundCashSummary';

// Presentation Boundary Conversion:
// Every dollar amount and share count in the UI's domain types (Fund.size/
// called/fmv/real, Holding.cost/fmv/real, Txn.value/shares, Quarter.mv/cost/
// sharesOut) is scaled in millions — ported verbatim from the mockup, whose
// FormFields say so explicitly ("Shares (millions)") and whose formatters
// (money/moneyK) assume it. The backend stores raw decimal strings.
// price-per-share fields (pps) are a real per-unit price and are NOT scaled.
const MILLION_STR = '1000000';
const M = 1_000_000;

function trimTrailingZeros(str: string): string {
  if (!str.includes('.')) return str;
  const trimmed = str.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/**
 * Central presentation helper: converts raw currency/unit amount (string or number)
 * to display millions (number). Decimal string inputs are divided by 1,000,000 using
 * exact decimal arithmetic before converting to Number.
 */
export function toDisplayMillions(
  v: number | string | null | undefined,
): number | null | undefined {
  if (v == null) return v as null | undefined;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    try {
      const divided = flDiv(trimmed, MILLION_STR, 8);
      const num = Number(divided);
      return Number.isNaN(num) ? null : num;
    } catch {
      const num = Number(v);
      return Number.isNaN(num) ? null : num / M;
    }
  }
  return Number.isNaN(v) ? null : v / M;
}

/**
 * Central presentation helper: converts display millions (number or string) back to raw
 * amount string. Uses exact decimal multiplication (× 1,000,000).
 */
export function fromDisplayMillionsToString(
  v: number | string | null | undefined,
): string | null | undefined {
  if (v == null) return v as null | undefined;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    try {
      return trimTrailingZeros(flMul(trimmed, MILLION_STR, 8));
    } catch {
      const num = Number(v);
      return Number.isNaN(num) ? null : trimTrailingZeros(toDecimalString(String(num * M), 8));
    }
  }
  if (Number.isNaN(v)) return null;
  return trimTrailingZeros(toDecimalString(String(v * M), 8));
}

/** Alias for backward compatibility with existing callers. */
export const toM = toDisplayMillions;

/** Alias for backward compatibility with existing callers returning number. */
export const fromM = (
  v: number | string | null | undefined,
): number | null | undefined => {
  if (v == null) return v as null | undefined;
  const rawStr = fromDisplayMillionsToString(v);
  if (rawStr == null) return null;
  const num = Number(rawStr);
  return Number.isNaN(num) ? null : num;
};

// IRR/XIRR are stored server-side as a fraction (0.09 = 9%) but the UI's
// Fund.irr/Quarter.xirr are plain percentage numbers (9 = 9%) — confirmed by
// FundTable's `{f.irr.toFixed(1)}%` and QuarterTable's `${v.toFixed(1)}%`,
// neither of which multiplies by 100 themselves. DPI/TVPI/MOIC are ratios in
// both places already and need no conversion.
export const toPct = (v: number | string | null | undefined): number | null | undefined => {
  if (v == null) return v as null | undefined;
  const num = typeof v === 'string' ? Number(v) : v;
  return Number.isNaN(num) ? null : num * 100;
};
export const fromPct = (v: number | string | null | undefined): number | null | undefined => {
  if (v == null) return v as null | undefined;
  const num = typeof v === 'string' ? Number(v) : v;
  return Number.isNaN(num) ? null : num / 100;
};

// ---- Fund-level historical trend (Commitment / Invested / Unrealized MV) ----

export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function trailingQuarterEnds(count: number, from: Date = new Date()): string[] {
  const quarterEnd = (year: number, quarterIdx: number) => new Date(year, quarterIdx * 3 + 3, 0);
  let year = from.getFullYear();
  let q = Math.floor(from.getMonth() / 3);
  if (quarterEnd(year, q) > from) {
    q -= 1;
  }
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    if (q < 0) {
      q = 3;
      year -= 1;
    }
    dates.unshift(toLocalISODate(quarterEnd(year, q)));
    q -= 1;
  }
  return dates;
}

export function quarterEndLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q}'${String(d.getFullYear()).slice(-2)}`;
}

function investedCapitalAsOf(
  txns: Array<{
    txn_type?: string;
    txn_date?: string;
    entry_type?: string;
    entry_date?: string;
    value_amount?: number | null;
    cash_delta?: string | number | null;
    price_per_share?: number | null;
    share_count?: number | null;
    fx_rate?: number | string | null;
  }>,
  asOfDate: string,
): string {
  const filtered = txns.filter((t) => {
    const date = t.txn_date ?? t.entry_date ?? '';
    const type =
      t.txn_type ??
      (t.entry_type === 'buy' || t.entry_type === 'paid_in'
        ? 'contribution'
        : t.entry_type);
    return (
      (type === 'contribution' || type === 'paid_in' || type === 'buy') &&
      date <= asOfDate
    );
  });

  let sumStr = '0.00000000';
  for (const t of filtered) {
    let amountStr = '0.00000000';
    if (t.cash_delta != null) {
      amountStr = flNeg(String(t.cash_delta));
    } else if (t.value_amount != null) {
      amountStr = String(t.value_amount);
      if ((t as any).is_reversal || (t as any).isReversal) {
        amountStr = flNeg(amountStr);
      }
    } else if (t.price_per_share != null && t.share_count != null) {
      amountStr = flMul(String(t.price_per_share), String(t.share_count));
      if ((t as any).is_reversal || (t as any).isReversal) {
        amountStr = flNeg(amountStr);
      }
    }
    const fxStr = t.fx_rate != null ? String(t.fx_rate) : '1';
    const amountWithFx = flMul(amountStr, fxStr);
    sumStr = flAdd(sumStr, amountWithFx);
  }
  return sumStr;
}

function unrealizedValueAsOf(
  valuations: Array<{
    as_of_date: string;
    market_value_amount?: number | null;
    market_value?: string | number | null;
  }>,
  asOfDate: string,
): string {
  const sorted = [...valuations].sort((a, b) =>
    a.as_of_date < b.as_of_date ? 1 : -1,
  );
  const latest = sorted.find((v) => v.as_of_date <= asOfDate);
  if (!latest) return '0.00000000';
  const val = latest.market_value ?? latest.market_value_amount ?? '0';
  return toDecimalString(String(val), 8);
}

export function computeFundHistory(
  perAsset: Array<{
    txns: Array<{
      txn_type?: string;
      txn_date?: string;
      entry_type?: string;
      entry_date?: string;
      sub_type?: string | null;
      sell_proceeds_destination?: string | null;
      value_amount?: number | null;
      cash_delta?: string | number | null;
      price_per_share?: number | null;
      share_count?: number | null;
      fx_rate?: number | string | null;
      is_reversal?: boolean;
    }>;
    valuations: Array<{ as_of_date: string; market_value_amount?: number | null; market_value?: string | number | null }>;
  }>,
  commitmentSizeAmount: number | string | null | undefined,
  quarterEnds: string[],
  options?: {
    cashPositions?: Array<{
      entries: Array<{
        entry_date: string;
        cash_delta?: string | number | null;
        is_reversal?: boolean;
      }>;
    }>;
    fxStatus?: 'available' | 'pending_fx';
    reportingTotalAvailable?: boolean;
  },
): FundHist {
  const committedM = toDisplayMillions(commitmentSizeAmount) ?? 0;
  return {
    committed: quarterEnds.map(() => committedM),
    called: quarterEnds.map((end) => {
      const totalCalledStr = flSum(
        perAsset.map((a) => investedCapitalAsOf(a.txns, end)),
      );
      return toDisplayMillions(totalCalledStr) ?? 0;
    }),
    fmv: quarterEnds.map((end) => {
      if (options?.fxStatus === 'pending_fx' || options?.reportingTotalAvailable === false) {
        return null;
      }
      // Holdings unrealized valuation
      const holdingsFmvStr = flSum(
        perAsset.map((a) => unrealizedValueAsOf(a.valuations, end)),
      );
      // As-of cash balance across cash positions: sum all dated signed cash deltas, including reversal rows.
      // Before reversal date, original economics remain; on/after reversal date, they net correctly.
      let cashAsOfStr = '0.00000000';
      if (options?.cashPositions) {
        for (const cp of options.cashPositions) {
          for (const e of cp.entries) {
            if (e.entry_date <= end && e.cash_delta != null) {
              cashAsOfStr = flAdd(cashAsOfStr, String(e.cash_delta));
            }
          }
        }
      }
      const totalFmvStr = flAdd(holdingsFmvStr, cashAsOfStr);
      return toDisplayMillions(totalFmvStr) ?? 0;
    }),
  };
}

// ---- Holding (fl_assets) <-> HoldingType / instrument_terms ----

export function assetTypeToHoldingType(
  assetType: string | null | undefined,
  typeDetails?: Record<string, unknown> | null,
): HoldingType {
  if (assetType === 'cash') return 'Cash';
  if (assetType === 'fund_of_funds') return 'Fund of funds';
  const instrumentType = typeDetails?.instrumentType;
  if (instrumentType === 'obligation' || assetType === 'loan') return 'Obligation';
  if (instrumentType === 'shares' || assetType === 'listed_security') return 'Shares';
  return 'Equity';
}

export function holdingTypeToAssetType(
  tp: HoldingType,
): { assetType: 'direct_investment' | 'cash' | 'fund_of_funds'; instrumentType?: 'equity' | 'obligation' | 'shares' } {
  if (tp === 'Cash') return { assetType: 'cash' };
  if (tp === 'Fund of funds') return { assetType: 'fund_of_funds' };
  if (tp === 'Obligation') return { assetType: 'direct_investment', instrumentType: 'obligation' };
  if (tp === 'Shares') return { assetType: 'direct_investment', instrumentType: 'shares' };
  return { assetType: 'direct_investment', instrumentType: 'equity' };
}

function typeDetailsToFacts(td: Record<string, unknown> | null | undefined): HoldingFacts {
  const d = (td ?? {}) as Record<string, unknown>;
  const facts: HoldingFacts = {};
  if (d.dealType != null) facts.dealType = String(d.dealType);
  if (d.entryEV != null) facts.entryEV = Number(d.entryEV);
  if (d.holdYrs != null) facts.holdYrs = Number(d.holdYrs);
  if (d.revenue != null) facts.revenue = Number(d.revenue);
  if (d.ebitda != null) facts.ebitda = Number(d.ebitda);
  if (d.noteType != null) facts.noteType = String(d.noteType);
  if (d.issuer != null) facts.issuer = String(d.issuer);
  if (d.coupon != null) facts.coupon = Number(d.coupon);
  if (d.principal != null) facts.principal = Number(d.principal);
  if (d.exchange != null) facts.exchange = String(d.exchange);
  if (d.ticker != null) facts.ticker = String(d.ticker);
  if (d.sharesOutstanding != null) facts.sharesK = Number(d.sharesOutstanding);
  if (d.marketCapUsdBn != null) facts.marketCapB = Number(d.marketCapUsdBn);
  if (d.pricePerShare != null) facts.pricePerShare = String(d.pricePerShare);
  if (d.type != null) facts.type = String(d.type);
  if (d.institution != null) facts.institution = String(d.institution);
  if (d.yieldPct != null) facts.yieldPct = Number(d.yieldPct);
  if (d.targetFundName != null) facts.targetFund = String(d.targetFundName);
  if (d.investingEntity != null) facts.entity = String(d.investingEntity);
  if (d.shareClass != null) facts.shareClass = String(d.shareClass);
  if (d.fundManagerName != null) facts.fundManagerName = String(d.fundManagerName);
  if (d.fundLifeYears != null) facts.fundLifeYears = Number(d.fundLifeYears);
  if (d.reportDate != null) facts.reportDate = String(d.reportDate);
  if (d.prefReturnRatePct != null) facts.prefReturnRatePct = Number(d.prefReturnRatePct);
  if (d.stakePct != null) facts.stakePct = Number(d.stakePct);
  if (d.keyRights != null) facts.keyRights = String(d.keyRights);
  if (d.businessUpdates != null) facts.businessUpdates = String(d.businessUpdates);
  return facts;
}

function factsToTypeDetails(
  tp: HoldingType,
  d: HoldingFacts | undefined,
  inv: Inv | undefined,
): Record<string, unknown> {
  const facts = d ?? {};
  if (tp === 'Cash') {
    return { type: facts.type, institution: facts.institution, yieldPct: facts.yieldPct };
  }
  if (tp === 'Fund of funds') {
    return {
      targetFundName: facts.targetFund,
      holdYrs: facts.holdYrs,
      investingEntity: inv?.entity,
      reportDate: inv?.reportDate,
      fundManagerName: facts.fundManagerName,
      fundLifeYears: facts.fundLifeYears,
    };
  }
  const { instrumentType } = holdingTypeToAssetType(tp);
  return {
    instrumentType,
    dealType: facts.dealType,
    entryEV: facts.entryEV,
    holdYrs: facts.holdYrs,
    revenue: facts.revenue,
    ebitda: facts.ebitda,
    noteType: facts.noteType,
    issuer: facts.issuer,
    coupon: facts.coupon,
    principal: facts.principal,
    exchange: facts.exchange,
    ticker: facts.ticker,
    sharesOutstanding: facts.sharesK,
    marketCapUsdBn: facts.marketCapB,
    pricePerShare: facts.pricePerShare,
    shareClass: facts.shareClass,
    investingEntity: inv?.entity,
    reportDate: inv?.reportDate,
    prefReturnRatePct: inv?.prefReturnRate,
  };
}

const HOLDING_STATUS: Record<string, string> = {
  active: 'Active',
  exiting: 'Exiting',
  exited: 'Exited',
  open: 'Active',
  closed: 'Exited',
};

// ---- V2 Portfolio & Position Adapters ----

export function flEntryToTxn(
  entry: FlPortfolioLedgerEntry,
  asOfDate?: string | null,
): Txn {
  let type: TxnType = 'Other';
  if (entry.entry_type === 'buy' || entry.entry_type === 'paid_in') {
    type = 'Buy';
  } else if (
    entry.entry_type === 'sell' ||
    entry.entry_type === 'distribution' ||
    entry.entry_type === 'redemption'
  ) {
    type = 'Sell';
  }

  const cashDeltaStr = entry.cash_delta || '0';
  const qtyDeltaStr = entry.quantity_delta || '0';
  const paidInAdjustmentStr = paidInAdjustmentDelta(entry);
  const valuationDeltaStr = isPaidInAdjustment(entry) ? '0' : entry.valuation_delta || '0';
  const rawCashAbsStr = flAbs(cashDeltaStr);
  const rawQtyAbsStr = flAbs(qtyDeltaStr);
  const rawValuationAbsStr = flAbs(valuationDeltaStr);
  const displayValueStr =
    entry.entry_type === 'adjustment' && !flIsZero(valuationDeltaStr)
      ? rawValuationAbsStr
      : entry.entry_type === 'adjustment' && !flIsZero(paidInAdjustmentStr)
        ? flAbs(paidInAdjustmentStr)
        : rawCashAbsStr;

  const rawCashStr = entry.is_reversal ? flNeg(rawCashAbsStr) : rawCashAbsStr;
  const rawQtyStr = entry.is_reversal ? flNeg(rawQtyAbsStr) : rawQtyAbsStr;

  const ppsStr =
    entry.price_per_unit != null && entry.price_per_unit !== ''
      ? String(entry.price_per_unit)
      : null;
  const ppsNum = ppsStr != null ? Number(ppsStr) : null;

  const isRetained =
    entry.sub_type === SUB_TYPE_DIVESTMENT_CASH_IN_FUND ||
    entry.sub_type === 'cash_in_fund';
  const isDistributed =
    entry.sub_type === SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR ||
    entry.sub_type === 'distributed_to_investor';
  const sellProceedsDestination: SellProceedsDestination | null =
    type === 'Sell'
      ? isRetained
        ? 'cash_in_fund'
        : isDistributed
          ? 'distributed_to_investor'
          : null
      : null;

  const reversalDate =
    entry.reversal_date ??
    (entry.event?.reversal_of_event_id ? entry.entry_date : null) ??
    null;
  const isReversedStatus = entry.event?.status === 'reversed' || Boolean(entry.reversal_date);
  const isReversedAsOf = Boolean(
    isReversedStatus && (!asOfDate || !reversalDate || asOfDate >= reversalDate),
  );

  return {
    id: entry.id,
    positionId: entry.position_id,
    date: entry.entry_date,
    eom: null,
    type,
    entryType: entry.entry_type,
    value: toDisplayMillions(entry.is_reversal ? flNeg(displayValueStr) : displayValueStr) ?? null,
    pps: ppsNum != null && !Number.isNaN(ppsNum) ? ppsNum : null,
    ppsCurrency: entry.currency || 'USD',
    shares: toDisplayMillions(rawQtyStr) ?? null,
    fx: entry.fx_rate != null ? String(entry.fx_rate) : null,
    notes: entry.notes,
    label: entry.sub_type ?? (entry.entry_type === 'income' ? 'Interest income' : undefined),
    fundingSourceId: entry.allocations?.[0]?.funding_source_id ?? null,
    allocations: (entry.allocations ?? []).map((allocation) => ({
      fundingSourceId: allocation.funding_source_id,
      amount: String(allocation.amount),
    })),
    sellProceedsDestination,
    isGenerated: false,
    isReversal: entry.is_reversal,
    isReversedOriginal: isReversedAsOf,
    reversalDate,
    rawCashDelta: cashDeltaStr,
    rawQuantityDelta: qtyDeltaStr,
    rawValuationDelta: valuationDeltaStr,
    rawPaidInAdjustmentDelta: paidInAdjustmentStr,
    rawPricePerUnit: ppsStr,
    rawValue: displayValueStr,
    rawShares: rawQtyAbsStr,
  };
}

export function flValuationToQuarter(v: Tables<'fl_valuations'>): Quarter {
  const ppsStr =
    v.price_per_unit != null && v.price_per_unit !== ''
      ? String(v.price_per_unit)
      : null;
  const ppsNum = ppsStr != null ? Number(ppsStr) : null;

  let cleanNotes = v.notes ?? undefined;
  let shPct: number | null = null;
  let moic: number | null = null;
  let xirr: number | null = null;
  let periodLabel: string | null = null;

  if (v.notes) {
    const metaIdx = v.notes.indexOf('source_meta:');
    if (metaIdx !== -1) {
      const jsonStr = v.notes.slice(metaIdx + 'source_meta:'.length).trim();
      try {
        const meta = JSON.parse(jsonStr);
        if (meta && typeof meta === 'object') {
          if (meta.shareholding_pct != null) shPct = Number(meta.shareholding_pct);
          if (meta.gross_moic != null) moic = Number(meta.gross_moic);
          if (meta.gross_xirr != null) {
            const xirrNum = Number(meta.gross_xirr);
            xirr = Number.isNaN(xirrNum) ? null : xirrNum;
          }
          if (meta.period_label) periodLabel = String(meta.period_label);
        }
        const rawUserNotes = v.notes.slice(0, metaIdx).trim();
        cleanNotes = rawUserNotes.replace(/\|\s*$/, '').trim() || undefined;
      } catch {
        // Preserve the entire user-authored note when the suffix is not valid metadata.
      }
    }
  }

  const rawMv = v.market_value != null ? String(v.market_value) : null;
  const rawCost = v.gross_value != null ? String(v.gross_value) : null;
  const rawNet = v.net_value != null ? String(v.net_value) : null;
  const rawUnits = v.units_outstanding != null ? String(v.units_outstanding) : null;

  return {
    id: v.id,
    asOfDate: v.as_of_date,
    q: periodLabel || quarterEndLabel(v.as_of_date) || v.as_of_date,
    mv: toDisplayMillions(rawMv) ?? null,
    cost: toDisplayMillions(rawCost) ?? null,
    pps: ppsNum != null && !Number.isNaN(ppsNum) ? ppsNum : null,
    ppsCurrency: v.currency || 'USD',
    sharesOut: toDisplayMillions(rawUnits) ?? null,
    shPct,
    moic,
    xirr,
    notes: cleanNotes ?? null,
    rawMarketValue: rawMv,
    rawGrossValue: rawCost,
    rawNetValue: rawNet,
    rawPricePerUnit: ppsStr,
    rawUnitsOutstanding: rawUnits,
  };
}

export function flPositionToHolding(
  pos: FlPortfolioPosition,
  entries: FlPortfolioLedgerEntry[],
  valuations: Tables<'fl_valuations'>[],
  asOfDate?: string | null,
): Holding {
  const isFoF = pos.fund_id != null && pos.asset_id == null;
  const asset = pos.asset;
  const targetFund = pos.fund;

  let tp: HoldingType = 'Equity';
  if (isFoF) {
    tp = 'Fund of funds';
  } else if (asset) {
    if (asset.asset_kind === 'cash') tp = 'Cash';
    else if (asset.asset_kind === 'loan') tp = 'Obligation';
    else if (asset.asset_kind === 'listed_security') tp = 'Shares';
    else tp = 'Equity';
  }

  const terms = (asset?.instrument_terms ?? {}) as Record<string, unknown>;
  const legacyMeta = (terms.legacy ?? {}) as Record<string, unknown>;
  const facts = typeDetailsToFacts(terms);
  const investmentType =
    (terms.investmentTypeLabel as string) ??
    (legacyMeta.investmentType as string) ??
    undefined;

  if (investmentType?.toLowerCase() === 'fund of funds') tp = 'Fund of funds';

  const rawCostStr =
    pos.balance?.contributed_capital != null
      ? String(pos.balance.contributed_capital)
      : '0.00000000';
  const isValued = pos.valuation_method !== null && pos.valuation_method !== undefined;
  const rawFmvStr = isValued
    ? pos.current_value != null
      ? String(pos.current_value)
      : '0.00000000'
    : null;
  const rawRealStr =
    pos.balance?.distributed_capital != null
      ? String(pos.balance.distributed_capital)
      : '0.00000000';

  let moic: number | null = null;
  if (rawFmvStr != null && !flIsZero(rawCostStr) && flGt(rawCostStr, '0')) {
    const totalReturnStr = flAdd(rawFmvStr, rawRealStr);
    const moicStr = flDiv(totalReturnStr, rawCostStr, 4);
    const moicNum = Number(moicStr);
    moic = Number.isNaN(moicNum) ? null : moicNum;
  }

  const sortedTxns = [...entries]
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0))
    .map((e) => flEntryToTxn(e, asOfDate));

  const sortedValuations = [...valuations]
    .sort((a, b) => (a.as_of_date < b.as_of_date ? -1 : a.as_of_date > b.as_of_date ? 1 : 0))
    .map(flValuationToQuarter);

  const holdingId = pos.asset_id ?? pos.fund_id ?? pos.id;
  const name = asset?.name ?? targetFund?.name ?? pos.notes ?? '(unnamed)';
  const englishName = asset?.english_name ?? targetFund?.english_name ?? undefined;
  const currency = (asset?.instrument_terms as any)?.investmentCurrency || targetFund?.base_currency || 'USD';
  const fundingSourceId = pos.holder_source_of_fund_id ?? null;
  const fundingSourceName = pos.funding_source?.name ?? (legacyMeta.fundingSourceName as string) ?? undefined;

  return {
    id: holdingId,
    targetKind: isFoF ? 'fund' : 'asset',
    n: name,
    englishName,
    tp,
    dt: pos.opened_at || '',
    cost: toDisplayMillions(rawCostStr) ?? 0,
    fmv: rawFmvStr != null ? (toDisplayMillions(rawFmvStr) ?? 0) : null,
    real: toDisplayMillions(rawRealStr) ?? 0,
    moic,
    st: pos.status === 'closed' ? 'Exited' : 'Active',
    investType: investmentType,
    fundingSourceId,
    positionId: pos.id,
    positionIds: [pos.id],
    valuationMethod: pos.valuation_method ?? null,
    valuationCoverage: isValued ? 'complete' : 'partial',
    asOfDate: asOfDate ?? null,
    rawCost: rawCostStr,
    rawFmv: rawFmvStr,
    rawReal: rawRealStr,
    d: {
      ...facts,
      geo: asset?.country ?? undefined,
      fundingSource: fundingSourceName,
      fundingSourceId,
    },
    inv: {
      legalName: asset?.legal_name ?? targetFund?.legal_name ?? undefined,
      entity: facts.entity ?? undefined,
      investType: investmentType,
      fundingSource: fundingSourceName,
      fundingSourceId,
      mgmtFeeRate: targetFund?.mgmt_fee_rate ? Number(targetFund.mgmt_fee_rate) * 100 : undefined,
      carryRate: targetFund?.carry_rate ? Number(targetFund.carry_rate) * 100 : undefined,
      stakePct:
        sortedValuations.length > 0 && sortedValuations[sortedValuations.length - 1].shPct != null
          ? sortedValuations[sortedValuations.length - 1].shPct
          : facts.stakePct ?? (legacyMeta.stakePct as number) ?? null,
      reportDate: facts.reportDate,
      prefReturnRate: facts.prefReturnRatePct,
      investCcy: currency,
      ccy: currency,
      country: asset?.country ?? undefined,
      description: asset?.description ?? targetFund?.description ?? undefined,
      keyRights: facts.keyRights ?? (legacyMeta.keyRights as string) ?? undefined,
      businessUpdates: facts.businessUpdates,
      asOfDate: asOfDate ?? null,
      txns: sortedTxns,
      quarterly: sortedValuations,
    },
  };
}

export function computeFundExposure(
  fundRow: Tables<'fl_funds'>,
  allPositions: FlPortfolioPosition[],
  allEntries: FlPortfolioLedgerEntry[],
  allValuations: Tables<'fl_valuations'>[],
  asOfDate?: string | null,
): FundExposure {
  const isCashPos = (p: FlPortfolioPosition) =>
    p.asset?.asset_kind === 'cash' || p.balance?.asset_kind === 'cash';

  const inboundPositions = allPositions.filter(
    (p) => p.fund_id === fundRow.id && !isCashPos(p),
  );

  const inboundHoldings = inboundPositions.map((pos) => {
    const posEntries = allEntries.filter((e) => e.position_id === pos.id);
    const enrichedPos = !pos.fund ? { ...pos, fund: fundRow } : pos;
    return flPositionToHolding(enrichedPos, posEntries, [], asOfDate);
  });

  const heldBy: string[] = [];
  for (const pos of inboundPositions) {
    const name = pos.holder_fund?.name ?? pos.holder_investor?.name;
    if (name && !heldBy.includes(name)) {
      heldBy.push(name);
    }
  }

  const currencies = new Set<string>();
  for (const pos of inboundPositions) {
    const posEntries = allEntries.filter((e) => e.position_id === pos.id);
    const posCurrencies = new Set<string>();
    for (const e of posEntries) {
      if (e.currency && typeof e.currency === 'string' && e.currency.trim()) {
        posCurrencies.add(e.currency.trim());
      }
    }
    if (posCurrencies.size === 0) {
      const ccy = pos.fund?.base_currency ?? fundRow.base_currency;
      if (ccy && typeof ccy === 'string' && ccy.trim()) {
        posCurrencies.add(ccy.trim());
      }
    }
    for (const c of posCurrencies) {
      currencies.add(c);
    }
  }

  const pendingFx = currencies.size > 1;
  const currency = pendingFx
    ? null
    : currencies.size === 1
      ? Array.from(currencies)[0]
      : fundRow.base_currency ?? null;

  if (pendingFx) {
    return {
      invested: null,
      fmv: null,
      realized: null,
      moic: null,
      dpi: null,
      heldBy,
      pendingFx: true,
      currency: null,
    };
  }

  const totalCostStr = flSum(
    inboundHoldings.map((h) => h.rawCost ?? '0.00000000'),
  );
  const totalRealStr = flSum(
    inboundHoldings.map((h) => h.rawReal ?? '0.00000000'),
  );
  const hasUnvalued = inboundHoldings.some((h) => h.fmv === null);
  const totalFmvStr = hasUnvalued
    ? null
    : flSum(
        inboundHoldings.map((h) => h.rawFmv ?? '0.00000000'),
      );

  const invested = toDisplayMillions(totalCostStr) ?? 0;
  const fmv = totalFmvStr !== null ? (toDisplayMillions(totalFmvStr) ?? 0) : null;
  const realized = toDisplayMillions(totalRealStr) ?? 0;

  const moic =
    invested > 0 && fmv !== null
      ? (fmv + realized) / invested
      : null;

  const dpi =
    invested > 0
      ? realized / invested
      : null;

  return {
    invested,
    fmv,
    realized,
    moic,
    dpi,
    heldBy,
    pendingFx: false,
    currency,
  };
}

export function buildFundFromPortfolio(
  fundRow: Tables<'fl_funds'>,
  allPositions: FlPortfolioPosition[],
  allEntries: FlPortfolioLedgerEntry[],
  allValuations: Tables<'fl_valuations'>[],
  asOfDate?: string | null,
  cashSummaryInput?: FundCashSummary,
  disclosure?: DisclosureReason | null,
): Fund {
  // LP positions under this fund
  const lpPositions = allPositions.filter(
    (p) => p.fund_id === fundRow.id && p.holder_investor_id != null,
  );
  const totalCommittedStr = flSum(
    lpPositions.map((p) =>
      p.balance?.commitment != null ? String(p.balance.commitment) : '0.00000000',
    ),
  );
  const totalCalledStr = flSum(
    lpPositions.map((p) =>
      p.balance?.drawn_commitment != null
        ? String(p.balance.drawn_commitment)
        : '0.00000000',
    ),
  );

  // Portfolio positions held by this fund
  const portPositions = allPositions.filter((p) => p.holder_fund_id === fundRow.id);

  // Separate cash positions and investment positions
  const isCashPos = (p: FlPortfolioPosition) =>
    p.asset?.asset_kind === 'cash' || p.balance?.asset_kind === 'cash';

  const investmentPositions = portPositions.filter((p) => !isCashPos(p));
  const cashPositions = portPositions.filter(isCashPos);

  const assetPositionCounts = new Map<string, number>();
  const targetFundPositionCounts = new Map<string, number>();
  for (const position of investmentPositions) {
    if (position.asset_id) {
      assetPositionCounts.set(position.asset_id, (assetPositionCounts.get(position.asset_id) ?? 0) + 1);
    }
    if (position.fund_id) {
      targetFundPositionCounts.set(position.fund_id, (targetFundPositionCounts.get(position.fund_id) ?? 0) + 1);
    }
  }

  // Holdings ONLY include investment positions (cash positions excluded)
  const holdings = investmentPositions.map((pos) => {
    const posEntries = allEntries.filter((e) => e.position_id === pos.id);
    const posValuations = allValuations.filter(
      (v) =>
        v.position_id === pos.id ||
        (v.position_id == null &&
          ((pos.asset_id && v.asset_id === pos.asset_id && assetPositionCounts.get(pos.asset_id) === 1) ||
            (pos.fund_id && v.fund_id === pos.fund_id && targetFundPositionCounts.get(pos.fund_id) === 1))),
    );
    return flPositionToHolding(pos, posEntries, posValuations, asOfDate);
  });

  // Valuation coverage check only over holdings (cash positions excluded)
  const hasUnvalued = holdings.some((h) => h.fmv === null || h.valuationMethod === null);
  const valuationCoverage: ValuationCoverage = hasUnvalued ? 'partial' : 'complete';

  const totalHoldingFmvStr = flSum(
    holdings
      .map((h) => h.rawFmv)
      .filter((v): v is string => v !== null && v !== undefined),
  );

  // DPI only sums distributions from investment positions (cash positions excluded)
  const totalRealDistributedStr = flSum(
    investmentPositions.map((p) =>
      p.balance?.distributed_capital != null
        ? String(p.balance.distributed_capital)
        : '0.00000000',
    ),
  );

  // Derive cash summary
  const cashSummary =
    cashSummaryInput ??
    computeFundCashSummary({
      fund: fundRow,
      positions: portPositions,
      entries: allEntries,
      asOfDate,
    });

  let totalFundFmvStr: string | null = null;
  let rawCashBalance: string | null = null;
  let cashBalanceM: number | null = null;

  if (cashSummary.reporting_total_available && cashSummary.reporting_total !== null) {
    const cashStr = cashSummary.reporting_total;
    totalFundFmvStr = flAdd(totalHoldingFmvStr, cashStr);
    rawCashBalance = cashStr;
    cashBalanceM = toDisplayMillions(cashStr) ?? 0;
  } else if (cashSummary.cash_status === 'incomplete_negative') {
    // Incomplete funding data: cash is negative, fall back to holdings-only.
    // Do NOT null the FMV: holdings valuation is still valid and nulling it would hide good data.
    totalFundFmvStr = totalHoldingFmvStr;
    rawCashBalance = null;
    cashBalanceM = null;
  } else {
    // Pending FX: never sum cash currencies nominally!
    // Never present holdings-only number as complete total FMV.
    totalFundFmvStr = null;
    rawCashBalance = null;
    cashBalanceM = null;
  }

  const sizeM = toDisplayMillions(totalCommittedStr) ?? 0;
  const calledM = toDisplayMillions(totalCalledStr) ?? 0;
  const fmvM = totalFundFmvStr !== null ? (toDisplayMillions(totalFundFmvStr) ?? 0) : null;
  const realM = toDisplayMillions(totalRealDistributedStr) ?? 0;

  let dpi = 0;
  if (!flIsZero(totalCalledStr) && flGt(totalCalledStr, '0')) {
    const dpiStr = flDiv(totalRealDistributedStr, totalCalledStr, 4);
    const dpiNum = Number(dpiStr);
    dpi = Number.isNaN(dpiNum) ? 0 : dpiNum;
  }

  let tvpi: number | null = null;
  if (
    valuationCoverage === 'complete' &&
    totalFundFmvStr !== null &&
    !flIsZero(totalCalledStr) &&
    flGt(totalCalledStr, '0')
  ) {
    const totalReturnedAndValue = flAdd(totalFundFmvStr, totalRealDistributedStr);
    const tvpiStr = flDiv(totalReturnedAndValue, totalCalledStr, 4);
    const tvpiNum = Number(tvpiStr);
    tvpi = Number.isNaN(tvpiNum) ? null : tvpiNum;
  }

  const fund: Fund = {
    ...(disclosure != null ? { displayOnly: true, disclosure } : {}),
    id: fundRow.id,
    n: fundRow.name,
    englishName: fundRow.english_name ?? undefined,
    legalName: fundRow.legal_name ?? undefined,
    v: fundRow.vintage_year ?? 0,
    size: sizeM,
    called: calledM,
    calledPct: sizeM ? (calledM / sizeM) * 100 : 0,
    fmv: fmvM,
    real: realM,
    dpi,
    tvpi,
    irr: 0,
    st: fundRow.status === 'harvesting' ? 'Harvesting' : fundRow.status === 'liquidated' ? 'Liquidated' : 'Investing',
    baseCurrency: fundRow.base_currency ?? 'USD',
    description: fundRow.description ?? undefined,
    h: holdings,
    valuationCoverage,
    rawSize: totalCommittedStr,
    rawCalled: totalCalledStr,
    rawFmv: totalFundFmvStr,
    rawReal: totalRealDistributedStr,
    cashBalances: cashSummary.cash_balances,
    cashBalance: cashBalanceM,
    rawCashBalance,
    cashStatus: cashSummary.cash_status,
    fxStatus: cashSummary.fx_status,
    reportingTotalAvailable: cashSummary.reporting_total_available,
  };

  const perAssetForHist = investmentPositions.map((pos) => {
    const posEntries = allEntries.filter((e) => e.position_id === pos.id);
    const posValuations = allValuations.filter(
      (v) =>
        (pos.asset_id && v.asset_id === pos.asset_id) ||
        (pos.fund_id && v.fund_id === pos.fund_id) ||
        v.position_id === pos.id,
    );
    return { txns: posEntries, valuations: posValuations };
  });

  const cashPositionsForHist = cashPositions.map((pos) => ({
    entries: allEntries.filter((e) => e.position_id === pos.id),
  }));

  fund.hist = computeFundHistory(
    perAssetForHist,
    totalCommittedStr,
    trailingQuarterEnds(4),
    {
      cashPositions: cashPositionsForHist,
      fxStatus: cashSummary.fx_status,
      reportingTotalAvailable: cashSummary.reporting_total_available,
    },
  );

  if (disclosure === 'external_fund') {
    fund.ourPosition = computeFundExposure(
      fundRow,
      allPositions,
      allEntries,
      allValuations,
      asOfDate,
    );
  }

  return fund;
}

export function buildOrphanAssetFund(
  assets: Tables<'fl_assets'>[],
  positions: FlPortfolioPosition[],
): Fund | null {
  const positionedAssetIds = new Set<string>();
  for (const p of positions) {
    if (p.asset_id) {
      positionedAssetIds.add(p.asset_id);
    }
  }

  const orphanAssets = assets.filter(
    (a) => a.asset_kind !== 'cash' && !positionedAssetIds.has(a.id),
  );

  if (orphanAssets.length === 0) {
    return null;
  }

  const orphanHoldings: Holding[] = orphanAssets.map((asset) => ({
    id: asset.id,
    targetKind: 'asset',
    n: asset.name,
    englishName: asset.english_name ?? undefined,
    tp: assetTypeToHoldingType(
      asset.asset_kind,
      asset.instrument_terms as Record<string, unknown> | null,
    ),
    dt: asset.created_at ?? '',
    cost: 0,
    fmv: null,
    real: 0,
    moic: null,
    st: 'Unlinked',
    displayOnly: true,
    disclosure: 'no_holder',
  }));

  return {
    id: 'unassigned',
    n: 'Unassigned Assets',
    displayOnly: true,
    disclosure: 'no_holder',
    v: 0,
    size: 0,
    called: 0,
    calledPct: 0,
    fmv: null,
    real: 0,
    dpi: 0,
    tvpi: null,
    irr: 0,
    st: 'Unlinked',
    h: orphanHoldings,
  };
}

export function buildEntityFromPortfolio(
  investorRow: Tables<'fl_investors'>,
  allPositions: FlPortfolioPosition[],
  allEntries: FlPortfolioLedgerEntry[],
  allValuations: Tables<'fl_valuations'>[],
  asOfDate?: string | null,
  parentInvestor?: { id: string; name: string } | null,
  allFunds?: Tables<'fl_funds'>[],
): Investor {
  // Portfolio positions held by this investor entity
  const portPositions = allPositions.filter(
    (p) => p.holder_investor_id === investorRow.id,
  );

  // Build fund map once for O(1) lookup
  const fundMap = new Map<string, Tables<'fl_funds'>>();
  if (allFunds) {
    for (const fund of allFunds) {
      if (fund?.id) {
        fundMap.set(fund.id, fund);
      }
    }
  }
  for (const pos of allPositions) {
    if (pos.fund) {
      const fundId = pos.fund.id ?? pos.fund_id;
      if (fundId && !fundMap.has(fundId)) {
        fundMap.set(fundId, pos.fund);
      }
    }
  }

  // Separate cash positions and investment positions
  const isCashPos = (p: FlPortfolioPosition) =>
    p.asset?.asset_kind === 'cash' || p.balance?.asset_kind === 'cash';

  // An entity holding is a non-cash asset or an unmanaged/external fund position.
  // Managed fund positions are LP commitment stakes (mirror side of fund capital)
  // and must not become holdings. If a referenced fund cannot be resolved, exclude it.
  const isInvestmentHolding = (p: FlPortfolioPosition) => {
    if (isCashPos(p)) return false;
    if (p.fund_id != null) {
      const targetFund = fundMap.get(p.fund_id);
      return targetFund !== undefined && targetFund.managed === false;
    }
    if (p.asset_id != null) {
      return true;
    }
    return false;
  };

  const investmentPositions = portPositions.filter(isInvestmentHolding);

  const assetPositionCounts = new Map<string, number>();
  const targetFundPositionCounts = new Map<string, number>();
  for (const position of investmentPositions) {
    if (position.asset_id) {
      assetPositionCounts.set(position.asset_id, (assetPositionCounts.get(position.asset_id) ?? 0) + 1);
    }
    if (position.fund_id) {
      targetFundPositionCounts.set(position.fund_id, (targetFundPositionCounts.get(position.fund_id) ?? 0) + 1);
    }
  }

  // Holdings ONLY include investment positions (cash positions excluded)
  const holdings = investmentPositions.map((pos) => {
    const posEntries = allEntries.filter((e) => e.position_id === pos.id);
    const posValuations = allValuations.filter(
      (v) =>
        v.position_id === pos.id ||
        (v.position_id == null &&
          ((pos.asset_id && v.asset_id === pos.asset_id && assetPositionCounts.get(pos.asset_id) === 1) ||
            (pos.fund_id && v.fund_id === pos.fund_id && targetFundPositionCounts.get(pos.fund_id) === 1))),
    );
    const targetFund = pos.fund_id ? fundMap.get(pos.fund_id) : undefined;
    const enrichedPos = targetFund && !pos.fund ? { ...pos, fund: targetFund } : pos;
    return flPositionToHolding(enrichedPos, posEntries, posValuations, asOfDate);
  });

  // Valuation coverage check only over holdings (cash positions excluded)
  const hasUnvalued = holdings.some((h) => h.fmv === null || h.valuationMethod === null);
  const valuationCoverage: ValuationCoverage = hasUnvalued ? 'partial' : 'complete';

  const totalHoldingFmvStr = flSum(
    holdings
      .map((h) => h.rawFmv)
      .filter((v): v is string => v !== null && v !== undefined),
  );

  const totalCostStr = flSum(
    holdings
      .map((h) => h.rawCost)
      .filter((v): v is string => v !== null && v !== undefined),
  );

  const totalRealDistributedStr = flSum(
    investmentPositions.map((p) =>
      p.balance?.distributed_capital != null
        ? String(p.balance.distributed_capital)
        : '0.00000000',
    ),
  );

  const totalEntityFmvStr = totalHoldingFmvStr;

  const unresolvedPositions = portPositions.filter(
    (p) => !isCashPos(p) && p.fund_id != null && fundMap.get(p.fund_id) === undefined,
  );

  const unresolvedHoldings: Holding[] = unresolvedPositions.map((pos) => {
    const posEntries = allEntries.filter((e) => e.position_id === pos.id);
    const posValuations = allValuations.filter((v) => v.position_id === pos.id);
    const baseHolding = flPositionToHolding(pos, posEntries, posValuations, asOfDate);
    return {
      ...baseHolding,
      displayOnly: true,
      disclosure: 'unresolved_target',
      fmv: null,
      moic: null,
      rawFmv: null,
    };
  });

  const groupId = investorRow.parent_investor_id ?? null;
  const groupName = parentInvestor?.name ?? null;

  return {
    id: investorRow.id,
    n: investorRow.name,
    englishName: investorRow.english_name ?? undefined,
    legalName: investorRow.legal_name ?? undefined,
    type: investorRow.investor_type ?? '',
    stakes: {},
    groupName,
    groupId,
    holdings: [...holdings, ...unresolvedHoldings],
    valuationCoverage,
    rawFmv: totalEntityFmvStr,
    rawCost: totalCostStr,
    rawReal: totalRealDistributedStr,
    fxStatus: 'available',
    reportingTotalAvailable: true,
  };
}

/**
 * Filters investor rows for display in the Investor tab / entity summary table.
 * Excludes parent group investors (any investor whose ID appears as another
 * investor's `parent_investor_id` or `groupId`).
 * Genuine internal entities that do not parent any other investor are preserved.
 */
export function filterEntityInvestors<
  T extends { id: string; parent_investor_id?: string | null; groupId?: string | null },
>(investors: T[]): T[] {
  const parentIds = new Set<string>();
  for (const inv of investors) {
    const parentId = inv.parent_investor_id ?? inv.groupId;
    if (parentId) {
      parentIds.add(parentId);
    }
  }
  return investors.filter((inv) => !parentIds.has(inv.id));
}

export interface AssetCreateField {
  key: string;
  label: string;
  kind: 'text' | 'num' | 'select' | 'date' | 'money';
  options?: string[];
  required?: boolean;
}

const DIRECT_INVESTMENT_FIELDS: AssetCreateField[] = [
  { key: 'name', label: 'Company name', kind: 'text', required: true },
  { key: 'englishName', label: 'English name', kind: 'text' },
];

export const ASSET_CREATE_FIELDS: Record<HoldingType, AssetCreateField[]> = {
  'Direct Investments': DIRECT_INVESTMENT_FIELDS,
  Equity: DIRECT_INVESTMENT_FIELDS,
  Cash: [
    { key: 'name', label: 'Label', kind: 'text' },
    { key: 'institution', label: 'Held at', kind: 'text' },
    { key: 'yieldPct', label: 'Interest earned (%)', kind: 'num' },
  ],
  Obligation: [
    { key: 'issuer', label: 'Borrower', kind: 'text' },
    {
      key: 'noteType',
      label: 'Loan type',
      kind: 'select',
      options: ['Convertible note', 'Bridge loan', 'Senior secured', 'Mezzanine'],
    },
    { key: 'coupon', label: 'Interest rate (%)', kind: 'num' },
    { key: 'maturity', label: 'Maturity date', kind: 'date' },
  ],
  Shares: [
    { key: 'name', label: 'Company / label', kind: 'text' },
    { key: 'exchange', label: 'Exchange', kind: 'text' },
    { key: 'ticker', label: 'Ticker', kind: 'text' },
  ],
  'Fund of funds': [
    { key: 'targetFund', label: 'Target fund name', kind: 'text' },
    { key: 'englishName', label: 'English name', kind: 'text' },
    { key: 'commit', label: 'Commitment', kind: 'money' },
  ],
};

export interface AssetCreatePayload {
  input: Record<string, unknown>;
  investedM: number | null;
  navM?: number | null;
  txnDate: string | null;
}

export function buildAssetCreatePayload(
  tp: HoldingType,
  values: Record<string, string>,
): AssetCreatePayload {
  const { assetType, instrumentType } = holdingTypeToAssetType(tp);
  const num = (k: string): number | null => (values[k]?.trim() ? Number(values[k]) : null);
  const txt = (k: string): string | null => values[k]?.trim() || null;
  const moneyM = (k: string): number | null => (toDisplayMillions(values[k]) ?? null);
  const status = 'active' as const;
  const investingEntity = txt('investingEntity') ?? undefined;
  const fundingSource = txt('fundingSource');

  let payload: AssetCreatePayload;
  if (tp === 'Cash') {
    payload = {
      input: {
        assetType,
        status,
        fundingSource,
        assetName: txt('name') ?? 'New holding',
        typeDetails: { institution: txt('institution') ?? undefined, yieldPct: num('yieldPct') ?? undefined },
      },
      investedM: moneyM('cost'),
      txnDate: null,
    };
  } else if (tp === 'Obligation') {
    payload = {
      input: {
        assetType,
        status,
        fundingSource,
        assetName: txt('issuer') ?? 'New holding',
        maturityDate: txt('maturity'),
        typeDetails: {
          instrumentType,
          investingEntity,
          noteType: txt('noteType') ?? undefined,
          coupon: num('coupon') ?? undefined,
          principal: moneyM('principal') ?? undefined,
        },
      },
      investedM: moneyM('principal'),
      txnDate: null,
    };
  } else if (tp === 'Shares') {
    payload = {
      input: {
        assetType,
        status,
        fundingSource,
        assetName: txt('name') ?? 'New holding',
        typeDetails: {
          instrumentType,
          investingEntity,
          exchange: txt('exchange') ?? undefined,
          ticker: txt('ticker') ?? undefined,
          sharesOutstanding: num('sharesK') ?? undefined,
        },
      },
      investedM: moneyM('cost'),
      txnDate: null,
    };
  } else if (tp === 'Fund of funds') {
    const commitM = moneyM('commit');
    payload = {
      input: {
        assetType,
        status,
        fundingSource,
        assetName: txt('targetFund') ?? 'New holding',
        englishName: txt('englishName'),
        commitmentAmount: commitM != null ? fromM(commitM) : undefined,
        typeDetails: { targetFundName: txt('targetFund') ?? undefined, investingEntity },
      },
      investedM: moneyM('calledFoF'),
      navM: moneyM('nav'),
      txnDate: null,
    };
  } else {
    payload = {
      input: {
        assetType,
        status,
        fundingSource,
        assetName: txt('name') ?? 'New holding',
        englishName: txt('englishName'),
        sector: txt('sector'),
        country: txt('geo'),
        entryDate: txt('dt'),
        typeDetails: {
          instrumentType,
          investingEntity,
          dealType: txt('dealType') ?? undefined,
          entryEV: moneyM('entryEV') ?? undefined,
          revenue: moneyM('revenue') ?? undefined,
          ebitda: moneyM('ebitda') ?? undefined,
        },
      },
      investedM: moneyM('cost'),
      txnDate: txt('dt'),
    };
  }
  return payload;
}

export function txnToLedgerEntryInput(
  t: Txn,
  positionId: string,
  options?: { isFoF?: boolean },
): LedgerEntryInput {
  const isBuy = t.type === 'Buy';
  const isSell = t.type === 'Sell';
  const isFoF =
    options?.isFoF ??
    (t.entryType === 'paid_in' ||
      t.entryType === 'distribution' ||
      t.entryType === 'redemption');

  // Obtain raw value and shares as EXACT decimal strings:
  // If t.rawValue / t.rawShares is present, use it; otherwise convert t.value / t.shares from millions to string.
  const rawValueStr =
    t.rawValue ??
    (t.value != null ? fromDisplayMillionsToString(t.value) : '0') ??
    '0';
  const rawSharesStr =
    t.rawShares ??
    (t.shares != null ? fromDisplayMillionsToString(t.shares) : '0') ??
    '0';

  const rawValueAbs = trimTrailingZeros(flAbs(rawValueStr));
  const rawSharesAbs = trimTrailingZeros(flAbs(rawSharesStr));

  const hasValue = !flIsZero(rawValueAbs);
  const hasShares = !flIsZero(rawSharesAbs);

  let entryType: EntryType;
  if (t.entryType) {
    entryType = t.entryType as EntryType;
  } else if (isFoF) {
    if (isBuy) {
      entryType = 'paid_in';
    } else if (isSell) {
      entryType = hasShares ? 'redemption' : 'distribution';
    } else if (
      t.label === 'Interest income' ||
      t.label === 'Return of capital' ||
      t.label === 'Distribution' ||
      t.label === 'Dividend'
    ) {
      entryType = 'distribution';
    } else {
      entryType = 'expense';
    }
  } else {
    entryType = isBuy
      ? 'buy'
      : isSell
        ? 'sell'
        : t.label === 'Interest income' || t.label === 'Return of capital'
          ? 'income'
          : 'expense';
  }

  const negValueStr = hasValue ? (rawValueAbs.startsWith('-') ? rawValueAbs : `-${rawValueAbs}`) : '0';
  const posValueStr = hasValue ? (rawValueAbs.startsWith('-') ? rawValueAbs.slice(1) : rawValueAbs) : '0';
  const negSharesStr = hasShares ? (rawSharesAbs.startsWith('-') ? rawSharesAbs : `-${rawSharesAbs}`) : '0';
  const posSharesStr = hasShares ? (rawSharesAbs.startsWith('-') ? rawSharesAbs.slice(1) : rawSharesAbs) : '0';

  let cashDelta = '0';
  let quantityDelta = '0';

  if (entryType === 'paid_in' || entryType === 'buy') {
    cashDelta = negValueStr;
    quantityDelta = posSharesStr;
  } else if (entryType === 'redemption') {
    cashDelta = posValueStr;
    quantityDelta = negSharesStr;
  } else if (entryType === 'sell') {
    cashDelta = posValueStr;
    quantityDelta = negSharesStr;
  } else if (entryType === 'distribution' || entryType === 'income') {
    cashDelta = posValueStr;
    quantityDelta = '0';
  } else {
    cashDelta = negValueStr;
    quantityDelta = '0';
  }

  const isDivestmentEntry =
    isSell || entryType === 'sell' || entryType === 'redemption' || entryType === 'distribution';
  const explicitSubType = isDivestmentEntry
    ? (toDivestmentSubType(t.sellProceedsDestination) ?? toDivestmentSubType(t.label))
    : null;
  const subType =
    explicitSubType ?? (t.label ?? (entryType === 'distribution' && isSell ? 'divestment' : null));

  return {
    position_id: positionId,
    entry_date: t.date,
    entry_type: entryType,
    sub_type: subType,
    commitment_delta: '0',
    quantity_delta: quantityDelta,
    cash_delta: cashDelta,
    currency: t.ppsCurrency || 'USD',
    price_per_unit: t.rawPricePerUnit ?? (t.pps != null ? String(t.pps) : null),
    fx_rate: t.fx ? String(t.fx) : null,
    notes: t.notes ?? null,
    allocations:
      t.allocations?.length && hasValue
        ? t.allocations.map((allocation) => ({
            funding_source_id: allocation.fundingSourceId,
            amount: allocation.amount,
          }))
        : t.fundingSourceId && hasValue
          ? [
            {
              funding_source_id: t.fundingSourceId,
              amount: rawValueAbs,
            },
            ]
          : undefined,
  };
}

export function quarterToValuationInput(
  q: Quarter,
  target: { asset_id?: string | null; fund_id?: string | null; position_id?: string | null },
): RecordValuationInput {
  const rawMv =
    q.rawMarketValue ??
    (q.mv != null ? fromDisplayMillionsToString(q.mv) : null);
  const rawCost =
    q.rawGrossValue ??
    (q.cost != null ? fromDisplayMillionsToString(q.cost) : null);
  const rawShares =
    q.rawUnitsOutstanding ??
    (q.sharesOut != null ? fromDisplayMillionsToString(q.sharesOut) : null);
  const rawPps =
    q.rawPricePerUnit ?? (q.pps != null ? String(q.pps) : null);

  const meta: Record<string, unknown> = {};
  if (q.q) meta.period_label = q.q;
  if (q.shPct != null) meta.shareholding_pct = q.shPct;
  if (q.moic != null) meta.gross_moic = q.moic;
  if (q.xirr != null) meta.gross_xirr = q.xirr;

  let combinedNotes: string | null = null;
  const userNotes = q.notes?.trim();
  const hasMeta = Object.keys(meta).length > 0;
  if (userNotes && hasMeta) {
    combinedNotes = `${userNotes} | source_meta: ${JSON.stringify(meta)}`;
  } else if (userNotes) {
    combinedNotes = userNotes;
  } else if (hasMeta) {
    combinedNotes = `source_meta: ${JSON.stringify(meta)}`;
  }

  return {
    asset_id: target.asset_id ?? null,
    fund_id: target.fund_id ?? null,
    position_id: target.position_id ?? null,
    as_of_date: q.asOfDate || toLocalISODate(new Date()),
    valuation_method: 'other',
    currency: q.ppsCurrency || 'USD',
    market_value: rawMv != null ? String(rawMv) : null,
    price_per_unit: rawPps,
    units_outstanding: rawShares != null ? String(rawShares) : null,
    gross_value: rawCost != null ? String(rawCost) : null,
    net_value: q.rawNetValue ?? (rawMv != null ? String(rawMv) : null),
    data_status: 'verified',
    notes: combinedNotes,
  };
}
