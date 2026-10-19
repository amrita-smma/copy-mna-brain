// Domain types for the Fund Management feature. Loose by design — this mirrors
// the free-form ledger the mockup was built against; most numeric fields are
// optional/nullable because the source spreadsheet leaves them blank.

import type { FundAiOpinionConfidence } from '@/lib/services/fundAiOpinionDataSufficiency';

export type { FundAiOpinionConfidence };

export type TxnType = 'Buy' | 'Sell' | 'Other';

import type { SellProceedsDestination } from '@/lib/sellProceedsDestination';
export type { SellProceedsDestination };

export interface Txn {
  /** Server-assigned id (fl_ledger_entries.id) — absent only for a
   * not-yet-saved row built inside TxnDialog before submit. */
  id?: string;
  /** Exact ledger position owning this entry. Never reconstruct this from the
   * instrument and the first funding allocation when editing an existing row. */
  positionId?: string | null;
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
  entryType?: string | null;
  fundId?: string | null;
  holdingEntityId?: string | null;
  fundingSourceId?: string | null;
  allocations?: Array<{ fundingSourceId: string; amount: string }>;
  sellProceedsDestination?: SellProceedsDestination | null;
  sourceDivestmentTxnId?: string | null;
  isGenerated?: boolean;
  isReversal?: boolean;
  /** The entry belongs to an original business event that has been reversed. */
  isReversedOriginal?: boolean;
  /** Linked reversal event date when this transaction has been reversed. */
  reversalDate?: string | null;
  /** Preserve exact ledger deltas/allocations/sibling legs for metadata-only edits. */
  preserveEconomicFields?: boolean;
  /** Exact string cash delta from backend without float precision loss. */
  rawCashDelta?: string | null;
  /** Exact string quantity delta from backend without float precision loss. */
  rawQuantityDelta?: string | null;
  /** Exact non-cash valuation delta from backend. */
  rawValuationDelta?: string | null;
  rawPaidInAdjustmentDelta?: string | null;
  /** Exact string price per unit from backend without float precision loss. */
  rawPricePerUnit?: string | null;
  /** Exact unsigned string cash amount (raw currency units). */
  rawValue?: string | null;
  /** Exact unsigned string share count. */
  rawShares?: string | null;
  /** Explicitly flag whether this transaction is an estimate/projection rather than an actual cash flow. */
  isEstimated?: boolean;
}

export interface Quarter {
  /** Server-assigned id (fl_valuations.id) — absent only for a
   * not-yet-saved row built inside QuarterDialog before submit. */
  id?: string;
  /** ISO date (fl_valuations.as_of_date) — the real key the backend
   * upserts on. `q` is a free-text period label (e.g. "Q2'25"), kept separate
   * since the mockup never collected a real date. */
  asOfDate?: string;
  q: string;
  mv?: number | null;
  cost?: number | null;
  pps?: number | null;
  /** Currency for `pps` in the Historical value tab (fl_valuations.currency). */
  ppsCurrency?: string | null;
  sharesOut?: number | null;
  shPct?: number | null;
  moic?: number | null;
  xirr?: number | null;
  notes?: string | null;
  /** Exact string market value from backend without float precision loss. */
  rawMarketValue?: string | null;
  /** Exact string gross value (cost) from backend without float precision loss. */
  rawGrossValue?: string | null;
  /** Exact string net value from backend without float precision loss. */
  rawNetValue?: string | null;
  /** Exact string price per unit from backend without float precision loss. */
  rawPricePerUnit?: string | null;
  /** Exact string units outstanding from backend without float precision loss. */
  rawUnitsOutstanding?: string | null;
}

export interface Inv {
  legalName?: string;
  entity?: string;
  investType?: string;
  fundingSource?: string;
  fundingSourceId?: string | null;
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
  asOfDate?: string | null;
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
  fundingSourceId?: string | null;
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
  // object (cash / loan / shares). Raw dollars.
  _investedAmount?: number | null;
  _fmvAmount?: number | null;
  // fund of funds
  targetFund?: string;
  commit?: number;
  calledFoF?: number;
  subSector?: string;
  reportDate?: string;
  prefReturnRatePct?: number;
  stakePct?: number;
  keyRights?: string;
  businessUpdates?: string;
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

export const HOLDING_TYPES: HoldingType[] = ['Direct Investments', 'Fund of funds', 'Cash'];

export type FundAiOpinionVerdict = 'buy' | 'hold' | 'sell';

export type ValuationCoverage = 'complete' | 'partial';

/** Why a row is shown even though it is not part of the portfolio's summing
 * set. Display-only rows render with a badge and never enter any total. */
export type DisclosureReason =
  | 'external_fund'       // fl_funds.managed = false
  | 'liquidated_fund'     // fl_funds.status = 'liquidated'
  | 'no_holder'           // fl_assets row with zero fl_positions
  | 'unresolved_target';  // position.fund_id references a fund not in the read model

export interface Holding {
  /** Target identity is independent of its display investment type. */
  targetKind?: 'asset' | 'fund';
  /** When true this row is disclosure-only: it renders with a badge and MUST be
   * skipped by every aggregate (totals, history, breakdowns, merges). */
  displayOnly?: boolean;
  /** Why this row is disclosure-only. Null/undefined on normal rows. */
  disclosure?: DisclosureReason | null;
  /** Server-assigned id (asset / target fund id). Always present on real (API-backed)
   * holdings; absent only on the static mock data used by the Investor tab
   * (no per-holding CRUD happens there). */
  id?: string;
  n: string;
  /** Free-text action items recorded on the asset (`fl_assets.action_items`). */
  actionItems?: string | null;
  /** The asset's investment type (`fl_assets.investment_type_id`), for the
   * "by Investment Type" grouping. */
  investmentTypeId?: string | null;
  /** English rendering of `n` — set when the asset is
   * recorded under a non-English name. Displayed in brackets after `n`. */
  englishName?: string;
  tp: HoldingType;
  dt: string;
  cost: number;
  fmv: number | null;
  real: number;
  moic: number | null;
  st: string;
  investType?: string;
  fundingSourceId?: string | null;
  positionId?: string | null;
  positionIds?: string[];
  valuationMethod?: string | null;
  valuationCoverage?: ValuationCoverage;
  d?: HoldingFacts;
  inv?: Inv;
  /** MB-470 AI Opinion — a firm buy/hold/sell verdict + rationale produced by
   * an AI Workforce run. */
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
  /** Optional as-of date filter for this holding view. */
  asOfDate?: string | null;
  /** Exact string contributed capital from position balance. */
  rawCost?: string | null;
  /** Exact string current valuation from position balance / mark. */
  rawFmv?: string | null;
  /** Exact string distributed capital from position balance. */
  rawReal?: string | null;
}

export interface FundHist {
  committed: number[];
  called: number[];
  fmv: (number | null)[];
  tvpi?: (number | null)[];
}

/** Our exposure to an externally managed fund (`fl_funds.managed = false`),
 *  aggregated over the inbound positions our funds/investors hold in it. */
export interface FundExposure {
  /** Sum of inbound position cost. Null when positions span >1 currency. */
  invested: number | null;
  /** Sum of inbound position FMV. Null if any position is unvalued, or >1 currency. */
  fmv: number | null;
  /** Sum of realized/distributed value. Null when >1 currency. */
  realized: number | null;
  /** (fmv + realized) / invested. Null unless invested > 0 and fmv != null. */
  moic: number | null;
  /** realized / invested. Null unless invested > 0. */
  dpi: number | null;
  /** Display names of the holders, in stable order (managed fund name, else investor name). */
  heldBy: string[];
  /** True when inbound positions span more than one currency — money fields are then null. */
  pendingFx: boolean;
  /** The single reporting currency when unambiguous, else null. */
  currency: string | null;
}

export interface Fund {
  /** When true this row is disclosure-only: it renders with a badge and MUST be
   * skipped by every aggregate (totals, history, breakdowns, merges). */
  displayOnly?: boolean;
  /** Why this row is disclosure-only. Null/undefined on normal rows. */
  disclosure?: DisclosureReason | null;
  /** Present only on external-fund rows (`disclosure === 'external_fund'`).
   *  Undefined on managed, liquidated and synthetic rows. */
  ourPosition?: FundExposure;
  /** Server-assigned id (fl_funds.id, a UUID). */
  id: string;
  n: string;
  englishName?: string;
  legalName?: string;
  v: number;
  size: number;
  called: number;
  calledPct: number;
  /** Unrealized MV in millions: holdings FMV only, never cash. Null ("—") when no holding is valued. */
  fmv: number | null;
  real: number;
  dpi: number;
  tvpi: number | null;
  irr: number;
  st: string;
  baseCurrency?: string;
  description?: string;
  startDate?: string;
  hist?: FundHist;
  h: Holding[];
  valuationCoverage?: ValuationCoverage;
  /** Exact string total committed capital from LP balances. */
  rawSize?: string | null;
  /** Exact string total called capital from LP balances. */
  rawCalled?: string | null;
  /** Exact string Unrealized MV: holdings FMV only, never cash. Null when no holding is valued. */
  rawFmv?: string | null;
  /** Exact string NAV (holdings FMV + cash balance), used only for TVPI. Null when cash is pending FX. */
  rawNav?: string | null;
  /** Exact string total real distributions from portfolio positions. */
  rawReal?: string | null;
  /** Per-currency cash balances. */
  cashBalances?: Array<{ currency: string; amount: string }>;
  /** Reporting-currency cash balance in millions, or null/undefined if multi-currency pending FX. */
  cashBalance?: number | null;
  /** Exact raw string cash balance in reporting currency. */
  rawCashBalance?: string | null;
  /** FX status: 'available' or 'pending_fx'. */
  fxStatus?: 'available' | 'pending_fx';
  /** Cash status: 'ok' or 'incomplete_negative' (when negative balances indicate missing funding data). */
  cashStatus?: 'ok' | 'incomplete_negative';
  /** Whether reporting currency total is available. */
  reportingTotalAvailable?: boolean;
}

export interface Investor {
  id: string;
  n: string;
  englishName?: string;
  legalName?: string;
  type: string;
  stakes: Record<string, number>;
  /** Actual investor/fund paid-in and distribution balances, in millions. */
  invested?: Record<string, number>;
  distributed?: Record<string, number>;
  /** Parent group investor's display name, when this entity belongs to one. */
  groupName?: string | null;
  /** Parent group investor id. */
  groupId?: string | null;
  /** Asset holdings this entity holds directly (investor-held positions). */
  holdings?: Holding[];
  fxStatus?: 'available' | 'pending_fx';
  reportingTotalAvailable?: boolean;
  valuationCoverage?: ValuationCoverage;
  rawFmv?: string | null;
  rawCost?: string | null;
  rawReal?: string | null;
}

export type IrrStatus = 'calculated' | 'unavailable';

export type IrrUnavailableReason =
  | 'insufficient_flows'
  | 'no_sign_change'
  | 'did_not_converge';

export type IrrReason = 'calculated' | IrrUnavailableReason;

export interface IrrResult {
  value: number | null;
  status: IrrStatus;
  reason: IrrReason;
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
  curPrice: number | null;
  unrealizedValue: number | null;
  totalValueGross: number | null;
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
  totalGrossGain: number | null;
  carryOwed: number | null;
  netTotalValue: number | null;
  grossMOIC: number | null;
  netMOIC: number | null;
  dpi: number;
  grossIRR: IrrResult | null;
  netIRR: IrrResult | null;
  unreal: number | null;
  avgBuy: number;
  avgSell: number;
  addOn: number;
  terminalDate?: string | null;
  quarterly: Quarter[];
}

/** Result of `computeFoF` — derived fund-of-funds metrics for one holding. */
export interface FoFMetrics {
  totalCalled: number;
  totalDist: number;
  totalOther: number;
  costInv: number;
  marketValue: number | null;
  netDist: number;
  moic: number | null;
  dpi: number;
  xirr: IrrResult | null;
  callsCount: number;
  distsCount: number;
  othersCount: number;
  terminalDate?: string | null;
  quarterly: Quarter[];
}

/** Identity of a position/holding holder (fund or investor entity) for display. */
export interface AssetHolderIdentity {
  id: string;
  /** Display label for the holder, e.g. "Apex Ventures I" or "Startech Ltd (Startech Group)". */
  name: string;
  /** Bare entity/fund name without parent group annotation. */
  rawName: string;
  kind: 'fund' | 'entity';
  groupName?: string | null;
  fund?: Fund;
  investor?: Investor;
}
