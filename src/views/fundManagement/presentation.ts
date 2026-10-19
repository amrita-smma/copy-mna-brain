// Read model for the Fund Management "Present" view: the Asset tab's whole-asset
// rows, grouped by investment type, laid out as a quarterly valuation report
// (No · Name · Entry Date · Maturity Date · Investment Commitment · Invested
// Capital · Net Distribution · Unrealized Market Value · MOIC · IRR · DPI).
// Pure functions only — the dialog renders whatever this returns.

import type { FlPortfolioPosition } from '@/lib/api/fundLedger';
import type { Fund, Holding, Investor } from './types';
import type { InvestmentTypeOption } from './context';
import {
  computeFoF,
  computeInv,
  getAssetDisplayName,
  isEstimatedTxn,
  isGeneratedCashMovement,
  mergeHoldingsAcrossFunds,
} from './calc';
import { toDisplayMillions } from './adapters';

/** Group for assets with no investment type (or one since deleted). */
export const UNASSIGNED_GROUP = 'Unassigned';

export interface PresentationRow {
  key: string;
  no: number;
  name: string;
  /** ISO date (YYYY-MM-DD) of the first capital deployment, or null. */
  entryDate: string | null;
  /** ISO date the investment matures, or null when unknown. */
  maturityDate: string | null;
  /** All money columns are in display millions. */
  commitment: number;
  invested: number;
  netDistribution: number;
  /** Null when the asset has no valuation. */
  unrealizedValue: number | null;
  moic: number | null;
  /** Annualised IRR as a fraction (0.047 = 4.7%), or null when not computable. */
  irr: number | null;
  dpi: number | null;
}

export interface PresentationTotals {
  commitment: number;
  invested: number;
  netDistribution: number;
  unrealizedValue: number;
  moic: number | null;
  dpi: number | null;
}

export interface PresentationGroup {
  name: string;
  rows: PresentationRow[];
  total: PresentationTotals;
}

export interface PresentationReport {
  groups: PresentationGroup[];
  grandTotal: PresentationTotals;
  /** Latest valuation mark across the reported assets (ISO date), or null. */
  latestValuationDate: string | null;
}

/**
 * Total commitment per investment target (asset id, or target fund id for a
 * fund-of-funds holding), in display millions, summed over every non-cash
 * position. Positions arrive with balances already cut at the as-of date.
 */
export function buildCommitmentByTarget(positions: FlPortfolioPosition[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of positions) {
    if (p.asset?.asset_kind === 'cash' || p.balance?.asset_kind === 'cash') continue;
    const target = p.asset_id ?? p.fund_id;
    if (!target) continue;
    const committed = toDisplayMillions(p.balance?.commitment ?? p.balance?.committed ?? null) ?? 0;
    if (committed === 0) continue;
    map.set(target, (map.get(target) ?? 0) + committed);
  }
  return map;
}

const isoDate = (v: string | null | undefined): string | null =>
  v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

/** First capital deployment: earliest actual (not generated or estimated) Buy/paid-in,
 * else the position open date. */
function entryDateOf(h: Holding): string | null {
  let earliest: string | null = null;
  for (const t of h.inv?.txns ?? []) {
    if (isGeneratedCashMovement(t) || isEstimatedTxn(t) || t.isReversal || t.isReversedOriginal) continue;
    const isDeployment = t.type === 'Buy' || t.entryType === 'paid_in' || t.entryType === 'buy';
    const d = isoDate(t.date);
    if (isDeployment && d && (earliest == null || d < earliest)) earliest = d;
  }
  return earliest ?? isoDate(h.dt);
}

/** Explicit maturity (loans), else entry date plus the fund life for a fund holding. */
function maturityDateOf(h: Holding, entryDate: string | null): string | null {
  const explicit = isoDate(h.d?.maturity);
  if (explicit) return explicit;
  const lifeYears = h.d?.fundLifeYears;
  if (entryDate && lifeYears != null && lifeYears > 0) {
    const [y, m, d] = entryDate.split('-').map(Number);
    const date = new Date(Date.UTC(y + Math.floor(lifeYears), m - 1, d));
    date.setUTCMonth(date.getUTCMonth() + Math.round((lifeYears % 1) * 12));
    return date.toISOString().slice(0, 10);
  }
  return null;
}

function irrOf(h: Holding): number | null {
  if (!h.inv) return null;
  const result = h.tp === 'Fund of funds' ? computeFoF(h)?.xirr : computeInv(h)?.grossIRR;
  return result?.status === 'calculated' && result.value != null && Number.isFinite(result.value)
    ? result.value
    : null;
}

function latestMarkOf(h: Holding): string | null {
  let latest = isoDate(h.latestValuationAsOf);
  for (const q of h.inv?.quarterly ?? []) {
    const d = isoDate(q.asOfDate);
    if (d && (latest == null || d > latest)) latest = d;
  }
  return latest;
}

function totalsOf(rows: PresentationRow[]): PresentationTotals {
  let commitment = 0;
  let invested = 0;
  let netDistribution = 0;
  let unrealizedValue = 0;
  let anyUnvalued = false;
  for (const r of rows) {
    commitment += r.commitment;
    invested += r.invested;
    netDistribution += r.netDistribution;
    if (r.unrealizedValue == null) anyUnvalued = true;
    else unrealizedValue += r.unrealizedValue;
  }
  return {
    commitment,
    invested,
    netDistribution,
    unrealizedValue,
    moic: anyUnvalued || invested <= 0 ? null : (unrealizedValue + netDistribution) / invested,
    dpi: invested > 0 ? netDistribution / invested : null,
  };
}

/**
 * Builds the report from the same whole-asset rows the Asset tab shows under
 * "No grouping" / "by Investment Type": co-invested assets merged into one row,
 * disclosure-only rows and cash left out. Groups follow the configured
 * investment-type order with "Unassigned" last; empty groups are omitted.
 * Rows are numbered continuously across groups, oldest entry first.
 */
export function buildPresentationReport({
  funds,
  investors,
  investmentTypes,
  commitmentByTarget,
  excludeFundTargets = false,
}: {
  funds: Fund[];
  investors?: Investor[];
  investmentTypes: InvestmentTypeOption[];
  commitmentByTarget?: Map<string, number>;
  /** Mirror the Asset tab: with Fund Vehicle View on, fund targets live in the Fund tab. */
  excludeFundTargets?: boolean;
}): PresentationReport {
  const keep = (h: Holding) => !(excludeFundTargets && h.targetKind === 'fund');
  const visibleFunds = funds.map((f) => ({ ...f, h: f.h.filter(keep) }));
  const visibleInvestors = investors?.map((e) => ({
    ...e,
    holdings: e.holdings?.filter(keep),
  }));

  const typeNameById = new Map(investmentTypes.map((t) => [t.id, t.name] as const));
  const byGroup = new Map<string, Omit<PresentationRow, 'no'>[]>();
  let latestValuationDate: string | null = null;

  for (const { key, h } of mergeHoldingsAcrossFunds(visibleFunds, visibleInvestors)) {
    if (h.displayOnly || h.tp === 'Cash') continue;
    const group = (h.investmentTypeId && typeNameById.get(h.investmentTypeId)) || UNASSIGNED_GROUP;
    const entryDate = entryDateOf(h);
    const committed =
      (h.id && commitmentByTarget?.get(h.id)) || toDisplayMillions(h.d?.commitmentAmount) || 0;
    const mark = latestMarkOf(h);
    if (mark && (latestValuationDate == null || mark > latestValuationDate)) {
      latestValuationDate = mark;
    }
    const row = {
      key,
      name: getAssetDisplayName(h),
      entryDate,
      maturityDate: maturityDateOf(h, entryDate),
      // Ledger commitment, else the fund interest's recorded commitment. A
      // direct investment has neither: what was invested is what was committed.
      commitment: committed > 0 ? committed : h.cost,
      invested: h.cost,
      netDistribution: h.real,
      unrealizedValue: h.fmv,
      moic: h.fmv == null || h.cost <= 0 ? null : (h.fmv + h.real) / h.cost,
      irr: irrOf(h),
      dpi: h.cost > 0 ? h.real / h.cost : null,
    };
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(row);
  }

  const order = new Map(investmentTypes.map((t, i) => [t.name, i] as const));
  const rank = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER;
  let no = 0;
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, rows]) => {
      const numbered = [...rows]
        .sort(
          (a, b) =>
            (a.entryDate ?? '9999').localeCompare(b.entryDate ?? '9999') ||
            a.name.localeCompare(b.name),
        )
        .map((r) => ({ ...r, no: ++no }));
      return { name, rows: numbered, total: totalsOf(numbered) };
    });

  return {
    groups,
    grandTotal: totalsOf(groups.flatMap((g) => g.rows)),
    latestValuationDate,
  };
}

/** Last calendar-quarter end on or before `date` (ISO). */
export function quarterEndOnOrBefore(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  const ends: [number, number][] = [[3, 31], [6, 30], [9, 30], [12, 31]];
  for (let i = ends.length - 1; i >= 0; i--) {
    const [em, ed] = ends[i];
    if (m > em || (m === em && d >= ed)) {
      return `${y}-${String(em).padStart(2, '0')}-${ed}`;
    }
  }
  return `${y - 1}-12-31`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 2017" */
export function formatMonthYear(iso: string | null): string {
  if (!iso) return '-';
  const [y, m] = iso.split('-').map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : '-';
}

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** "Sep 30th, 2026" */
export function formatPeriodEnd(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${ordinal(d)}, ${y}`;
}

/** Millions to one decimal; negative zero prints as 0.0. */
export const fmtAmount = (v: number | null): string =>
  v == null ? '-' : (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);
export const fmtMoic = (v: number | null): string => (v == null ? '-' : `${v.toFixed(2)}x`);
export const fmtIrr = (v: number | null): string => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
export const fmtDpi = (v: number | null): string => (v == null ? '-' : `${v.toFixed(1)}x`);
