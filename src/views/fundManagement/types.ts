// Domain types for the Fund Management feature. Loose by design — this mirrors
// the free-form ledger the mockup was built against; most numeric fields are
// optional/nullable because the source spreadsheet leaves them blank.

import type { FundAiOpinionConfidence } from '@/lib/services/fundAiOpinionDataSufficiency';

export type { FundAiOpinionConfidence };

export type TxnType = 'Buy' | 'Sell' | 'Distribution' | 'Other';

export interface Txn {
  /** Server-assigned id (fund_asset_transactions.id) — absent only for a
   * not-yet-saved row built inside TxnDialog before submit. */
  id?: string;
  date: string;
  eom?: string | null;
  type: TxnType;
  value?: number | null;
  pps?: number | null;
  ppsCurrency?: string | null;
  shares?: number | null;
  fx?: string | null;
  notes?: string | null;
  label?: string;
  fundId?: string | null;
  holdingEntityId?: string | null;
  fundingSourceId?: string | null;
}

export interface Quarter {
  /** Server-assigned id (fund_asset_valuations.id) — absent only for a
   * not-yet-saved row built inside QuarterDialog before submit. */
  id?: string;
  /** ISO date (fund_asset_valuations.as_of_date) — the real key the backend
   * upserts on. `q` is a free-text period label (e.g. "Q2'25"), kept separate
   * since the mockup never collected a real date. */
  asOfDate?: string;
  q: string;
  mv?: number | null;
  cost?: number | null;
  pps?: number | null;
  /** Currency for `pps` in the Historical value tab (fund_asset_valuations.currency). */
  ppsCurrency?: string | null;
  sharesOut?: number | null;
  shPct?: number | null;
  moic?: number | null;
  xirr?: number | null;
  notes?: string | null;
}

export interface Inv {
  legalName?: string;
  entity?: string;
  investType?: string;
  fundingSource?: string;
  mgmtFeeRate?: number;
  prefReturnRate?: number;
  carryRate?: number;
  subscriptionFee?: number;
  legalFees?: number;
  stakePct?: number | null;
  reportDate?: string;
  investCcy?: string;
  ccy?: string;
  country?: string;
  description?: string;
  businessUpdates?: string;
  keyRights?: string;
  txns: Txn[];
  quarterly: Quarter[];
  /** Live-edited current price/share override (Deal economics tab). */
  _cur?: number;
  _grossMoic?: number;
  _grossIrr?: number;
  _dpi?: number;
  _investedCapitalAmount?: number;
  _netDistributionAmount?: number;
  _shareCount?: number;
  _fmvAmount?: number;
}

export interface HoldingFacts {
  entity?: string;
  fundingSource?: string;
  structure?: string;
  mgmtFeeRate?: number;
  description?: string;
  holdYrs?: number;
  geo?: string;
  sheet?: string;
  // obligation
  noteType?: string;
  issuer?: string;
  principal?: number;
  maturity?: string;
  coupon?: number;
  // equity extras
  sector?: string;
  dealType?: string;
  entryEV?: number;
  entryMult?: number;
  revenue?: number;
  ebitda?: number;
  ebitdaMargin?: number;
  shareClass?: string;
  // public shares
  exchange?: string;
  ticker?: string;
  sharesK?: number;
  pricePerShare?: string;
  marketCapB?: number;
  // cash
  type?: string;
  institution?: string;
  yieldPct?: number;
  // Transient manual amount overrides for holding types without an `inv`
  // object (cash / loan / shares). Raw dollars. Never persisted into
  // type_details — they map to the asset's invested_capital_amount /
  // fmv_amount columns via holdingToAssetUpdateInput, mirroring the way
  // Inv._investedCapitalAmount / _fmvAmount work for equity/FoF.
  _investedAmount?: number | null;
  _fmvAmount?: number | null;
  // fund of funds
  targetFund?: string;
  commit?: number;
  calledFoF?: number;
  nav?: number;
  fundManagerName?: string;
  fundLifeYears?: number;
}

// 'Direct Investments' is the current Add-Asset picker option; it persists as
// asset_type=direct_investment (equity instrument) and therefore reloads as
// 'Equity'. 'Equity'/'Obligation'/'Shares' remain for existing rows created
// before the picker was trimmed.
export type HoldingType =
  | 'Direct Investments'
  | 'Equity'
  | 'Fund of funds'
  | 'Obligation'
  | 'Shares'
  | 'Cash';

export type FundAiOpinionVerdict = 'buy' | 'hold' | 'sell';

export interface Holding {
  /** Server-assigned id (fund_assets.id). Always present on real (API-backed)
   * holdings; absent only on the static mock data used by the Investor tab
   * (no per-holding CRUD happens there). */
  id?: string;
  n: string;
  /** English rendering of `n` (fund_assets.english_name) — set when the asset is
   * recorded under a non-English name. Displayed in brackets after `n`. */
  englishName?: string;
  tp: HoldingType;
  dt: string;
  cost: number;
  fmv: number;
  real: number;
  moic: number;
  st: string;
  investType?: string;
  d?: HoldingFacts;
  inv?: Inv;
  /** MB-470 AI Opinion — a firm buy/hold/sell verdict + rationale produced by
   * an AI Workforce run, written onto fund_assets.ai_opinion_*. */
  aiOpinionVerdict?: FundAiOpinionVerdict | null;
  aiOpinionSummary?: string | null;
  aiOpinionStatus?: string | null;
  aiOpinionConfidence?: FundAiOpinionConfidence | null;
  /** Server-computed sparse-data reasons (semicolon-separated), when any. */
  aiOpinionDataGaps?: string | null;
  aiOpinionUpdatedAt?: string | null;
  /** Latest valuation mark date — used to flag a stale opinion. */
  latestValuationAsOf?: string | null;
  /** Live sufficiency flag for the empty-state "limited data" hint. */
  aiOpinionIsSparse?: boolean;
}

export interface FundHist {
  committed: number[];
  called: number[];
  fmv: number[];
}

export interface Fund {
  /** Server-assigned id (funds.id, a UUID). */
  id: string;
  n: string;
  v: number;
  size: number;
  called: number;
  calledPct: number;
  fmv: number;
  real: number;
  dpi: number;
  tvpi: number;
  irr: number;
  st: string;
  baseCurrency?: string;
  description?: string;
  startDate?: string;
  hist?: FundHist;
  h: Holding[];
}

export interface Investor {
  id: string;
  n: string;
  type: string;
  stakes: Record<string, number>;
}

/** Result of `computeInv` — the derived equity metrics for one holding. */
export interface EquityMetrics {
  investedCapital: number;
  realizedProceedsGross: number;
  otherVal: number;
  divestment: number;
  sharesAcquired: number;
  sharesDisposed: number;
  sharesHeld: number;
  blendedEntryPrice: number;
  curPrice: number;
  unrealizedValue: number;
  totalValueGross: number;
  holdYrs: number;
  mgmtFeeRate: number;
  carryRate: number;
  legalFees: number;
  subscriptionFee: number;
  cumulativeMgmtFees: number;
  allInCostBasis: number;
  prefReturnRatePct: number;
  mgmtFeeVal: number;
  prefReturnVal: number;
  carryVal: number;
  totalFeesVal: number;
  totalGrossGain: number;
  carryOwed: number;
  netTotalValue: number;
  grossMOIC: number;
  netMOIC: number;
  dpi: number;
  grossIRR: number;
  netIRR: number;
  unreal: number;
  avgBuy: number;
  avgSell: number;
  addOn: number;
  quarterly: Quarter[];
}

/** Result of `computeFoF` — derived fund-of-funds metrics for one holding. */
export interface FoFMetrics {
  totalCalled: number;
  totalDist: number;
  totalOther: number;
  costInv: number;
  marketValue: number;
  netDist: number;
  moic: number;
  dpi: number;
  xirr: number;
  callsCount: number;
  distsCount: number;
  othersCount: number;
  quarterly: Quarter[];
}
