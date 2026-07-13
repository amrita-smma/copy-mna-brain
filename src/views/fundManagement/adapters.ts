// Explicit field-by-field mapping between backend rows (snake_case DB shape,
// from src/lib/api/funds.ts) and the UI's domain types (./types.ts, ported
// from the mockup). Kept as one file so a dropped/renamed field on either
// side is easy to spot by reading top to bottom.

import type {
  AssetTypeDetails,
  CashDetails,
  DirectInvestmentDetails,
  FundOfFundsDetails,
} from '@/lib/db/schema';
import type { Tables } from '@/lib/repositories';
import type {
  CreateAssetInput,
  CreateTransactionInput,
  UpdateAssetInput,
  UpsertValuationInput,
} from '@/lib/api/funds';
import type { Fund, FundHist, Holding, HoldingFacts, HoldingType, Inv, Quarter, Txn, TxnType } from './types';

type FundRow = Tables<'funds'>;
type AssetRow = Tables<'fund_assets'>;
type TxnRow = Tables<'fund_asset_transactions'>;
type ValuationRow = Tables<'fund_asset_valuations'>;

// Every dollar amount and share count in the UI's domain types (Fund.size/
// called/fmv/real, Holding.cost/fmv/real, Txn.value/shares, Quarter.mv/cost/
// sharesOut) is scaled in millions — ported verbatim from the mockup, whose
// FormFields say so explicitly ("Shares (millions)") and whose formatters
// (money/moneyK) assume it. The backend stores raw dollars/share counts.
// price-per-share fields (pps) are a real per-unit price and are NOT scaled.
const M = 1_000_000;
const toM = (v: number | null | undefined): number | null | undefined =>
  v == null ? v : v / M;
const fromM = (v: number | null | undefined): number | null | undefined =>
  v == null ? v : v * M;

// IRR/XIRR are stored server-side as a fraction (0.09 = 9%) but the UI's
// Fund.irr/Quarter.xirr are plain percentage numbers (9 = 9%) — confirmed by
// FundTable's `{f.irr.toFixed(1)}%` and QuarterTable's `${v.toFixed(1)}%`,
// neither of which multiplies by 100 themselves. DPI/TVPI/MOIC are ratios in
// both places already and need no conversion.
const toPct = (v: number | null | undefined): number | null | undefined =>
  v == null ? v : v * 100;
const fromPct = (v: number | null | undefined): number | null | undefined =>
  v == null ? v : v / 100;

// ---- Fund ----

export function fundRowToFund(row: FundRow): Fund {
  const size = toM(row.commitment_size_amount) ?? 0;
  const called = toM(row.called_amount) ?? 0;
  return {
    id: row.id,
    n: row.name,
    v: row.vintage_year ?? 0,
    size,
    called,
    calledPct: size ? (called / size) * 100 : 0,
    fmv: toM(row.fmv_amount) ?? 0,
    real: toM(row.realized_amount) ?? 0,
    dpi: row.dpi ?? 0,
    tvpi: row.tvpi ?? 0,
    irr: toPct(row.irr) ?? 0,
    st: row.status === 'harvesting' ? 'Harvesting' : 'Investing',
    baseCurrency: row.base_currency ?? undefined,
    description: row.description ?? undefined,
    h: [],
  };
}

// ---- Fund-level historical trend (Commitment / Invested / Unrealized MV) ----
//
// The mockup's "How this fund changed recently" sparklines came from 4
// hand-authored quarters baked into static mock data. There's no backend
// equivalent of that — fund_asset_valuations/fund_asset_transactions are the
// only real historical sources, and they're asset-level, not fund-level, so
// the fund-level trend has to be derived by re-running each asset's own
// as-of-date logic at several historical checkpoints and summing across the
// fund's assets, rather than read off a single column.

// `Date#toISOString()` converts to UTC first, which shifts a local midnight
// back a day in any timezone behind UTC — format from local getters instead.
export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns `count` trailing *completed* calendar-quarter-end ISO dates,
 * oldest first (e.g. the 4 quarters ending at the most recently completed
 * quarter as of `from`). */
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

/** "2026-06-30" -> "Q2'26" */
export function quarterEndLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q}'${String(d.getFullYear()).slice(-2)}`;
}

/** Cumulative contribution capital (raw dollars, fx-converted) recorded on
 * or before `asOfDate` — the same identity FundMetricsService uses for
 * invested_capital_amount, just truncated to a historical date. */
function investedCapitalAsOf(txns: TxnRow[], asOfDate: string): number {
  return txns
    .filter((t) => t.txn_type === 'contribution' && t.txn_date <= asOfDate)
    .reduce((sum, t) => {
      const amount =
        t.value_amount ??
        (t.price_per_share != null && t.share_count != null ? t.price_per_share * t.share_count : 0);
      return sum + amount * (t.fx_rate ?? 1);
    }, 0);
}

/** The latest valuation snapshot recorded on or before `asOfDate` (raw
 * dollars) — `valuations` is expected pre-sorted desc by as_of_date, same
 * order FundAssetValuationRepository returns. 0 if the asset has no
 * valuation that old yet (e.g. it wasn't acquired until later). */
function unrealizedValueAsOf(valuations: ValuationRow[], asOfDate: string): number {
  const latest = valuations.find((v) => v.as_of_date <= asOfDate);
  return latest?.market_value_amount ?? 0;
}

/** Builds the fund-level `hist` trend from every asset's raw ledger —
 * `perAsset` must be the same txns/valuations already fetched to build each
 * asset's Holding, so this adds no extra network calls. Commitment has no
 * historical source in this schema (LP commitments aren't tracked over
 * time), so it's shown as a flat line at the fund's current commitment —
 * `growth()` on a flat series correctly reports "no change". */
export function computeFundHistory(
  perAsset: Array<{ txns: TxnRow[]; valuations: ValuationRow[] }>,
  commitmentSizeAmount: number | null | undefined,
  quarterEnds: string[],
): FundHist {
  const committedM = toM(commitmentSizeAmount) ?? 0;
  return {
    committed: quarterEnds.map(() => committedM),
    called: quarterEnds.map(
      (end) => toM(perAsset.reduce((sum, a) => sum + investedCapitalAsOf(a.txns, end), 0)) ?? 0,
    ),
    fmv: quarterEnds.map(
      (end) => toM(perAsset.reduce((sum, a) => sum + unrealizedValueAsOf(a.valuations, end), 0)) ?? 0,
    ),
  };
}

// ---- Holding (fund_assets) <-> HoldingType / type_details ----

export function assetTypeToHoldingType(
  assetType: AssetRow['asset_type'],
  typeDetails: AssetTypeDetails | null | undefined,
): HoldingType {
  if (assetType === 'cash') return 'Cash';
  if (assetType === 'fund_of_funds') return 'Fund of funds';
  const instrumentType = (typeDetails as DirectInvestmentDetails | undefined)?.instrumentType;
  if (instrumentType === 'obligation') return 'Obligation';
  if (instrumentType === 'shares') return 'Shares';
  return 'Equity';
}

export function holdingTypeToAssetType(
  tp: HoldingType,
): { assetType: AssetRow['asset_type']; instrumentType?: 'equity' | 'obligation' | 'shares' } {
  if (tp === 'Cash') return { assetType: 'cash' };
  if (tp === 'Fund of funds') return { assetType: 'fund_of_funds' };
  if (tp === 'Obligation') return { assetType: 'direct_investment', instrumentType: 'obligation' };
  if (tp === 'Shares') return { assetType: 'direct_investment', instrumentType: 'shares' };
  // 'Direct Investments' and legacy 'Equity' both persist as an equity
  // direct investment (and reload as 'Equity').
  return { assetType: 'direct_investment', instrumentType: 'equity' };
}

function typeDetailsToFacts(td: AssetTypeDetails | null | undefined): HoldingFacts {
  const d = (td ?? {}) as DirectInvestmentDetails & FundOfFundsDetails & CashDetails;
  const facts: HoldingFacts = {};
  if (d.dealType != null) facts.dealType = d.dealType;
  if (d.entryEV != null) facts.entryEV = d.entryEV;
  if (d.holdYrs != null) facts.holdYrs = d.holdYrs;
  if (d.revenue != null) facts.revenue = d.revenue;
  if (d.ebitda != null) facts.ebitda = d.ebitda;
  if (d.noteType != null) facts.noteType = d.noteType;
  if (d.issuer != null) facts.issuer = d.issuer;
  if (d.coupon != null) facts.coupon = d.coupon;
  if (d.principal != null) facts.principal = d.principal;
  if (d.exchange != null) facts.exchange = d.exchange;
  if (d.ticker != null) facts.ticker = d.ticker;
  if (d.sharesOutstanding != null) facts.sharesK = d.sharesOutstanding;
  if (d.marketCapUsdBn != null) facts.marketCapB = d.marketCapUsdBn;
  if (d.pricePerShare != null) facts.pricePerShare = d.pricePerShare;
  if (d.type != null) facts.type = d.type;
  if (d.institution != null) facts.institution = d.institution;
  if (d.yieldPct != null) facts.yieldPct = d.yieldPct;
  if (d.targetFundName != null) facts.targetFund = d.targetFundName;
  if (d.investingEntity != null) facts.entity = d.investingEntity;
  if (d.shareClass != null) facts.shareClass = d.shareClass;
  if (d.fundManagerName != null) facts.fundManagerName = d.fundManagerName;
  if (d.fundLifeYears != null) facts.fundLifeYears = d.fundLifeYears;
  return facts;
}

/** Builds the full `type_details` blob from the holding's current in-memory
 * `d`/`inv` state — used by `holdingToAssetUpdateInput` on every save, not
 * just field-specific patches, since `type_details` is a single jsonb column. */
function factsToTypeDetails(
  tp: HoldingType,
  d: HoldingFacts | undefined,
  inv: Inv | undefined,
): AssetTypeDetails {
  const facts = d ?? {};
  if (tp === 'Cash') {
    return { type: facts.type, institution: facts.institution, yieldPct: facts.yieldPct } satisfies CashDetails;
  }
  if (tp === 'Fund of funds') {
    return {
      targetFundName: facts.targetFund,
      holdYrs: facts.holdYrs,
      investingEntity: inv?.entity,
      reportDate: inv?.reportDate,
      fundManagerName: facts.fundManagerName,
      fundLifeYears: facts.fundLifeYears,
    } satisfies FundOfFundsDetails;
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
  } satisfies DirectInvestmentDetails;
}

const HOLDING_STATUS: Record<NonNullable<AssetRow['status']>, string> = {
  active: 'Active',
  exiting: 'Exiting',
  exited: 'Exited',
};

/** Derives unrealized market value, which has no persisted column on
 * fund_assets: `totalValueGross = gross_moic * invested_capital_amount`
 * (the same identity FundMetricsService uses to compute gross_moic), then
 * `fmv = totalValueGross - net_distribution_amount`. Falls back to the
 * latest valuation snapshot when there's no invested capital to divide by —
 * mirroring FundMetricsService.computeAssetMetrics's own fallback. */
function deriveFmv(asset: AssetRow, latestValuation: ValuationRow | undefined): number {
  // A manually-overridden asset stores its unrealized value directly in
  // fmv_amount (see FundMetricsService, which returns fmv_amount verbatim for
  // overridden assets) — honor it so an edited value round-trips instead of
  // being re-derived from gross_moic.
  if (asset.is_manually_overridden && asset.fmv_amount != null) return asset.fmv_amount;
  const invested = asset.invested_capital_amount ?? 0;
  if (invested > 0) {
    const totalValueGross = (asset.gross_moic ?? 0) * invested;
    return totalValueGross - (asset.net_distribution_amount ?? 0);
  }
  return latestValuation?.market_value_amount ?? 0;
}

export function assetRowToHolding(
  asset: AssetRow,
  txns: TxnRow[],
  valuations: ValuationRow[],
): Holding {
  const tp = assetTypeToHoldingType(asset.asset_type, asset.type_details);
  // Cash gets an `inv` (like Equity/FoF) so it carries a full transaction
  // ledger. It's value-based (no shares/PPS), so it uses the FoF-style
  // rollups (see calc.ts) and the FoF-mode TxnTable.
  const hasInv = tp === 'Equity' || tp === 'Fund of funds' || tp === 'Cash';
  const latestValuation = valuations[0]; // repo orders desc by as_of_date

  const holding: Holding = {
    id: asset.id,
    n: asset.asset_name ?? asset.legal_name ?? '(unnamed)',
    tp,
    dt: asset.entry_date ?? '',
    cost: toM(asset.invested_capital_amount) ?? 0,
    fmv: toM(deriveFmv(asset, latestValuation)) ?? 0,
    real: toM(asset.net_distribution_amount) ?? 0,
    moic: asset.gross_moic ?? 0,
    st: asset.status ? HOLDING_STATUS[asset.status] : 'Active',
    investType: asset.investment_type ?? undefined,
    d: {
      ...typeDetailsToFacts(asset.type_details),
      geo: asset.country ?? undefined,
      maturity: asset.maturity_date ?? undefined,
    },
  };

  if (hasInv) {
    const td = asset.type_details as (DirectInvestmentDetails & FundOfFundsDetails) | null;
    holding.inv = {
      legalName: asset.legal_name ?? undefined,
      entity: td?.investingEntity ?? undefined,
      investType: asset.investment_type ?? undefined,
      fundingSource: asset.funding_source ?? undefined,
      mgmtFeeRate: asset.mgmt_fee_rate_pct ?? undefined,
      prefReturnRate: (td as DirectInvestmentDetails | null)?.prefReturnRatePct ?? undefined,
      carryRate: asset.carry_rate_pct ?? undefined,
      subscriptionFee: toM(asset.subscription_fee_amount) ?? undefined,
      legalFees: toM(asset.legal_fees_amount) ?? undefined,
      stakePct: asset.stake_pct ?? null,
      reportDate: td?.reportDate ?? undefined,
      investCcy: asset.investment_currency ?? undefined,
      ccy: asset.report_currency ?? undefined,
      country: asset.country ?? undefined,
      description: asset.investment_description ?? undefined,
      keyRights: asset.key_rights ?? undefined,
      // Both ledgers are shown ascending by date. Transactions arrive from the
      // repo ordered by txn_date; valuations arrive DESC (newest first, so
      // `latestValuation` above is index 0), so re-sort a copy ascending here
      // for `quarterly`. Ascending order also makes `quarterly[length - 1]` the
      // latest snapshot, which computeInv/computeFoF rely on for "latest MV".
      txns: [...txns]
        .sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0))
        .map(txnRowToTxn),
      quarterly: [...valuations]
        .sort((a, b) => (a.as_of_date < b.as_of_date ? -1 : a.as_of_date > b.as_of_date ? 1 : 0))
        .map(valuationRowToQuarter),
      _cur: asset.current_price_per_share ?? undefined,
      _grossMoic: asset.gross_moic ?? undefined,
      _grossIrr: asset.gross_irr ?? undefined,
      _dpi: asset.dpi ?? undefined,
      _investedCapitalAmount: asset.invested_capital_amount ?? undefined,
      _netDistributionAmount: asset.net_distribution_amount ?? undefined,
      _shareCount: asset.share_count ?? undefined,
      _fmvAmount: asset.fmv_amount ?? undefined,
    };
  }

  return holding;
}

/** Builds a full asset PATCH payload from the holding's current in-memory
 * state — used by `commitHolding` on every field edit (see context.ts).
 * `assetType` is intentionally omitted: it's not updatable via PATCH. */
export function holdingToAssetUpdateInput(holding: Holding): UpdateAssetInput {
  const inv = holding.inv;
  const d = holding.d;
  return {
    assetName: holding.n,
    legalName: inv?.legalName,
    // `d.geo` (not `inv.country`) is the only field the Legal tab ever
    // writes — falling back to `inv.country` would re-send its stale
    // initial-load value whenever the user clears this field.
    country: d?.geo,
    fundingSource: inv?.fundingSource,
    investmentType: inv?.investType ?? holding.investType,
    // `|| null` (not `|| undefined`): an empty string means the user
    // cleared the field, and the PATCH route only clears a column when the
    // key is present with a non-undefined value.
    entryDate: holding.dt || null,
    // Only obligations populate `d.maturity`; leaving it undefined for every
    // other asset type keeps the PATCH from touching (and clearing) the column.
    maturityDate: d?.maturity === undefined ? undefined : d.maturity || null,
    stakePct: inv?.stakePct,
    investmentCurrency: inv?.investCcy,
    reportCurrency: inv?.ccy,
    investmentDescription: inv?.description,
    keyRights: inv?.keyRights,
    subscriptionFeeAmount: fromM(inv?.subscriptionFee),
    mgmtFeeRatePct: inv?.mgmtFeeRate,
    carryRatePct: inv?.carryRate,
    legalFeesAmount: fromM(inv?.legalFees),
    typeDetails: factsToTypeDetails(holding.tp, d, inv),
    currentPricePerShare: inv?._cur,
    grossMoic: inv?._grossMoic,
    grossIrr: inv?._grossIrr,
    dpi: inv?._dpi,
    // For equity/FoF the manual amount overrides live on `inv`; for the
    // generic types (cash/loan/shares, no `inv`) they live on `d`.
    investedCapitalAmount: inv?._investedCapitalAmount ?? d?._investedAmount,
    netDistributionAmount: inv?._netDistributionAmount,
    shareCount: inv?._shareCount,
    fmvAmount: inv?._fmvAmount ?? d?._fmvAmount,
  };
}

export interface AssetCreateField {
  key: string;
  label: string;
  kind: 'text' | 'num' | 'select' | 'date' | 'money';
  options?: string[];
  required?: boolean;
}

/** Per-type initial-creation fields, ported from the mockup's `FORMS` table
 * (openDrawer/renderDrawer) so "+ asset" collects the same upfront profile
 * as the original mock instead of just a name. */
/** Fields shared by 'Direct Investments' and legacy 'Equity'. */
const DIRECT_INVESTMENT_FIELDS: AssetCreateField[] = [
  { key: 'name', label: 'Company name', kind: 'text', required: true },
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
    { key: 'commit', label: 'Commitment', kind: 'money' },
  ],
};

export interface AssetCreatePayload {
  input: CreateAssetInput;
  /** Invested-capital-equivalent figure (cost/principal/calledFoF), in
   * millions — becomes the asset's first ledger transaction, since
   * fund_assets has no directly-settable cost column. Null if left blank. */
  investedM: number | null;
  /** Fund-of-funds only: seeds an initial valuation snapshot. */
  navM?: number | null;
  txnDate: string | null;
}

/** Maps the Add Asset dialog's raw per-type field values into a create
 * payload — mirrors the mockup's saveDrawer(), except the "invested"
 * figure becomes a real ledger transaction instead of a direct cost field
 * (fund_assets has no such column; invested_capital_amount is derived). */
export function buildAssetCreatePayload(
  tp: HoldingType,
  values: Record<string, string>,
): AssetCreatePayload {
  const { assetType, instrumentType } = holdingTypeToAssetType(tp);
  const num = (k: string): number | null => (values[k]?.trim() ? Number(values[k]) : null);
  const txt = (k: string): string | null => values[k]?.trim() || null;
  // Money (`kind: 'money'`) fields hold a raw currency amount from
  // CurrencyInput; the domain stores millions, so convert at the boundary.
  const moneyM = (k: string): number | null => (toM(num(k)) ?? null);
  const status = 'active' as const;
  // Investment Entity (type_details) + Source of Fund (funding_source) are
  // collected on every asset type by the two shared comboboxes.
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
        commitmentAmount: commitM != null ? fromM(commitM) : undefined,
        typeDetails: { targetFundName: txt('targetFund') ?? undefined, investingEntity },
      },
      investedM: moneyM('calledFoF'),
      navM: moneyM('nav'),
      txnDate: null,
    };
  } else {
    // Direct Investments / Equity (default)
    payload = {
      input: {
        assetType,
        status,
        fundingSource,
        assetName: txt('name') ?? 'New holding',
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

// ---- Transactions ----

const TXN_TYPE_FROM_BACKEND: Record<TxnRow['txn_type'], TxnType> = {
  contribution: 'Buy',
  divestment: 'Sell',
  distribution: 'Distribution',
  interest_income: 'Other',
  return_of_capital: 'Other',
  other: 'Other',
};

const OTHER_LABEL_FROM_BACKEND: Partial<Record<TxnRow['txn_type'], string>> = {
  interest_income: 'Interest income',
  return_of_capital: 'Return of capital',
};

export function txnRowToTxn(row: TxnRow): Txn {
  const type = TXN_TYPE_FROM_BACKEND[row.txn_type];
  const label =
    type === 'Other' ? (row.sub_type_label ?? OTHER_LABEL_FROM_BACKEND[row.txn_type]) : undefined;
  return {
    id: row.id,
    date: row.txn_date,
    eom: null, // eom_date was dropped from the ledger — see the schema doc
    type,
    value: toM(row.value_amount) ?? null,
    pps: row.price_per_share,
    ppsCurrency: row.txn_currency ?? null,
    shares: toM(row.share_count) ?? null,
    // fx_rate is numeric server-side; the UI field is free text, so this is
    // a best-effort stringified round trip, not a distinct currency-pair label.
    fx: row.fx_rate != null ? String(row.fx_rate) : null,
    notes: row.notes,
    label,
    fundId: row.fund_id ?? null,
    holdingEntityId: row.holding_entity_id ?? null,
    fundingSourceId: row.funding_source_id ?? null,
  };
}

/**
 * Widening the UI's 4-value TxnType to the backend's 6 txn_type values would
 * break calc.ts's `computeInv`/`computeFoF`, which switch on exactly
 * 'Buy'|'Sell'|'Distribution'|'Other' — so interest_income/return_of_capital
 * fold into 'Other' with a label instead. Editing an existing
 * interest_income/return_of_capital transaction through the UI and saving it
 * loses that specific sub-type (it becomes plain 'other' unless the label
 * matches one of the two special-cased strings above) — an accepted,
 * documented lossy edge, not a bug.
 */
export function txnToPayload(t: Txn): CreateTransactionInput {
  const txnType: CreateTransactionInput['txnType'] =
    t.type === 'Buy'
      ? 'contribution'
      : t.type === 'Sell'
        ? 'divestment'
        : t.type === 'Distribution'
          ? 'distribution'
          : t.label === 'Interest income'
            ? 'interest_income'
            : t.label === 'Return of capital'
              ? 'return_of_capital'
              : 'other';
  const subTypeLabel = txnType === 'other' ? (t.label ?? null) : null;
  const fxRate = t.fx ? Number.parseFloat(t.fx) : null;
  return {
    txnDate: t.date,
    txnType,
    subTypeLabel,
    pricePerShare: t.pps ?? null,
    shareCount: fromM(t.shares) ?? null,
    valueAmount: fromM(t.value) ?? null,
    fxRate: fxRate != null && Number.isFinite(fxRate) ? fxRate : null,
    notes: t.notes ?? null,
    fundId: t.fundId ?? null,
    holdingEntityId: t.holdingEntityId ?? null,
    fundingSourceId: t.fundingSourceId ?? null,
  };
}

// ---- Valuations ----

export function valuationRowToQuarter(row: ValuationRow): Quarter {
  return {
    id: row.id,
    asOfDate: row.as_of_date,
    q: row.period_label ?? row.as_of_date,
    mv: toM(row.market_value_amount) ?? null,
    cost: toM(row.invested_capital_cum_amount) ?? null,
    pps: row.price_per_share,
    ppsCurrency: row.currency ?? null,
    sharesOut: toM(row.shares_outstanding) ?? null,
    shPct: row.shareholding_pct,
    moic: row.gross_moic,
    xirr: toPct(row.gross_xirr) ?? null,
    notes: row.notes,
  };
}

export function quarterToPayload(q: Quarter, asOfDate: string): UpsertValuationInput {
  return {
    asOfDate,
    periodLabel: q.q,
    currency: q.ppsCurrency ?? undefined,
    marketValueAmount: fromM(q.mv) ?? null,
    pricePerShare: q.pps ?? null,
    sharesOutstanding: fromM(q.sharesOut) ?? null,
    shareholdingPct: q.shPct ?? null,
    investedCapitalCumAmount: fromM(q.cost) ?? null,
    grossMoic: q.moic ?? null,
    grossXirr: fromPct(q.xirr) ?? null,
    notes: q.notes ?? null,
  };
}
