/**
 * Post-import catalog check (MB-642).
 *
 * The parse-time reconciliation compares the workbook's rows against its own
 * `基金汇总` summary. This compares what the import actually WROTE to the ledger
 * against those rows and that summary, and classifies each difference:
 *
 * - `posting`: the ledger does not match the submitted rows, as the parse-time
 *   reconciliation totals them. The write path recorded something other than
 *   what was approved (a flow counted in two books, a row that did not post, an
 *   entry on the wrong position, a duplicate of an earlier entry).
 * - `review`: the ledger matches those row totals, but they differ from
 *   `基金汇总`. The review step's reconciliation already flagged it, whether the
 *   workbook disagrees with itself or the import models a row differently.
 *
 * Advisory only: it never blocks or fails an import.
 */
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import { reconcileNanjingFundLedger } from './parsers/nanjing_fund_ledger';
import type { FundCatalogItem, ParsedAsset, ParsedCommitmentEvent, ParsedTxn } from './types';

export type CatalogCheckMetric = 'commitment' | 'paid_in' | 'invested' | 'cash';

/** A fund's ledger totals in CNY, as the fund view reports them. */
export interface FundLedgerTotals {
  committed: number;
  /** Paid-in including non-cash paid-in write-offs, as the fund view shows it. */
  paidIn: number;
  /** Paid-in from cash rows only — what the workbook's 实缴 rows add up to. */
  paidInCash: number;
  invested: number;
  cash: number;
}

/** A fund's totals over the workbook rows submitted in this approval, in CNY. */
export interface FundRowFigures {
  committed: number;
  paidIn: number;
  invested: number;
}

export type CatalogCheckDifferenceKind = 'posting' | 'review';

export interface CatalogCheckDifference {
  fund: string;
  metric: CatalogCheckMetric;
  kind: CatalogCheckDifferenceKind;
  ledgerValue: number;
  /** Total of the submitted rows; null when row figures were not available. */
  rowsValue: number | null;
  catalogValue: number | null;
  /** `posting`: ledger − rows (ledger − summary without row figures). `review`: ledger − summary. */
  diff: number;
}

export interface CatalogLedgerCheckResult {
  checked_funds: number;
  differences: CatalogCheckDifference[];
  /** Catalog funds not checked because only some of their rows were selected. */
  skipped_funds: string[];
  /** Catalog funds with rows (or, without row figures, any figures) that have no fund in the ledger. */
  missing_funds: string[];
  /** Posting differences and missing funds: what the import may have written wrong. */
  warnings: string[];
  /** Differences already flagged in review, and skipped funds: informational. */
  notes: string[];
}

export interface CatalogCheckInputs {
  /** Row totals per fund, keyed by `normalizeCanonicalName(fund name)`. */
  rowFigures?: Map<string, FundRowFigures>;
  /** Funds (same key) with rows left out of this approval. */
  partialFunds?: Set<string>;
  /**
   * Funds (same key) with any row in the workbook. A catalog fund outside it
   * has nothing to post, so having no ledger fund is expected, not missing.
   */
  fundsWithRows?: Set<string>;
}

// The summary states 万元 to 4 decimal places, i.e. 1 CNY.
const TOLERANCE_CNY = 1;

const METRICS: CatalogCheckMetric[] = ['commitment', 'paid_in', 'invested', 'cash'];

const METRIC_LABELS: Record<CatalogCheckMetric, string> = {
  commitment: 'commitments',
  paid_in: 'paid-in',
  invested: 'invested',
  cash: 'cash',
};

function catalogValueFor(item: FundCatalogItem, metric: CatalogCheckMetric): number | null {
  switch (metric) {
    case 'commitment':
      return item.subscribedAmount;
    case 'paid_in':
      return item.paidInAmount;
    case 'invested':
      return item.investedAmount;
    case 'cash':
      return item.netCashFlowAmount ?? null;
  }
}

// The summary's net cash flow is itself a sum over the rows, so it is both the
// rows figure and the summary figure for cash.
function rowsValueFor(
  item: FundCatalogItem,
  rows: FundRowFigures | undefined,
  metric: CatalogCheckMetric,
): number | null {
  if (metric === 'cash') return item.netCashFlowAmount ?? null;
  if (!rows) return null;
  switch (metric) {
    case 'commitment':
      return rows.committed;
    case 'paid_in':
      return rows.paidIn;
    case 'invested':
      return rows.invested;
  }
}

function ledgerValueFor(
  totals: FundLedgerTotals,
  metric: CatalogCheckMetric,
  againstRows: boolean,
): number {
  switch (metric) {
    case 'commitment':
      return totals.committed;
    case 'paid_in':
      // 实缴 rows are cash; a write-off only posts when the reviewer resolves it.
      return againstRows ? totals.paidInCash : totals.paidIn;
    case 'invested':
      return totals.invested;
    case 'cash':
      return totals.cash;
  }
}

function hasCatalogFigures(item: FundCatalogItem): boolean {
  return (
    item.subscribedAmount != null ||
    item.paidInAmount != null ||
    item.investedAmount != null
  );
}

function formatCny(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatDiff(value: number): string {
  return `${value > 0 ? '+' : ''}${formatCny(value)}`;
}

function describeDifference(difference: CatalogCheckDifference): string {
  const { fund, metric, kind, ledgerValue, rowsValue, catalogValue, diff } = difference;
  const label = METRIC_LABELS[metric];
  if (kind === 'review') {
    return `${fund}: ledger ${label} CNY ${formatCny(ledgerValue)} vs 基金汇总 CNY ${formatCny(catalogValue ?? 0)} (diff ${formatDiff(diff)}); already flagged in review, and the ledger matches the import's rows.`;
  }
  if (rowsValue == null) {
    return `${fund}: ledger ${label} CNY ${formatCny(ledgerValue)} vs 基金汇总 CNY ${formatCny(catalogValue ?? 0)} (diff ${formatDiff(diff)}).`;
  }
  const summary =
    catalogValue != null && metric !== 'cash' ? `; 基金汇总 CNY ${formatCny(catalogValue)}` : '';
  return `${fund}: ledger ${label} CNY ${formatCny(ledgerValue)} vs rows CNY ${formatCny(rowsValue)} (diff ${formatDiff(diff)}${summary}).`;
}

/**
 * Catalog funds worth checking: those the summary sheet states figures for.
 * Ledger-only funds (added to the catalog from 基金流水明细) have none.
 */
export function catalogItemsToCheck(items: FundCatalogItem[] | undefined): FundCatalogItem[] {
  return (items ?? []).filter(hasCatalogFigures);
}

/**
 * Compares each catalog fund's ledger totals with its submitted rows and its
 * stated figures. `ledgerTotals` is keyed by `normalizeCanonicalName(fund name)`;
 * a catalog fund missing from it has no ledger fund.
 */
export function compareCatalogToLedger(
  items: FundCatalogItem[],
  ledgerTotals: Map<string, FundLedgerTotals>,
  inputs: CatalogCheckInputs = {},
): CatalogLedgerCheckResult {
  const differences: CatalogCheckDifference[] = [];
  const skippedFunds: string[] = [];
  const missingFunds: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  let checkedFunds = 0;

  for (const item of catalogItemsToCheck(items)) {
    const key = normalizeCanonicalName(item.nameZh);
    if (inputs.partialFunds?.has(key)) {
      skippedFunds.push(item.nameZh);
      notes.push(`${item.nameZh}: not checked (partial import — not all of its rows were selected).`);
      continue;
    }
    const totals = ledgerTotals.get(key);
    if (!totals && inputs.fundsWithRows && !inputs.fundsWithRows.has(key)) {
      notes.push(`${item.nameZh}: not checked (no rows in this workbook and no fund in the ledger).`);
      continue;
    }
    if (!totals) {
      missingFunds.push(item.nameZh);
      warnings.push(`${item.nameZh}: listed in 基金汇总 but no fund was recorded in the ledger.`);
      continue;
    }
    checkedFunds += 1;
    const rows = inputs.rowFigures?.get(key);

    for (const metric of METRICS) {
      const catalogValue = catalogValueFor(item, metric);
      const rowsValue = rowsValueFor(item, rows, metric);
      let difference: CatalogCheckDifference | null = null;

      if (rowsValue != null) {
        const ledgerValue = ledgerValueFor(totals, metric, true);
        const postingDiff = ledgerValue - rowsValue;
        if (Math.abs(postingDiff) >= TOLERANCE_CNY) {
          difference = { fund: item.nameZh, metric, kind: 'posting', ledgerValue, rowsValue, catalogValue, diff: postingDiff };
        } else if (catalogValue != null && Math.abs(ledgerValue - catalogValue) >= TOLERANCE_CNY) {
          difference = { fund: item.nameZh, metric, kind: 'review', ledgerValue, rowsValue, catalogValue, diff: ledgerValue - catalogValue };
        }
      } else if (catalogValue != null) {
        const ledgerValue = ledgerValueFor(totals, metric, false);
        const diff = ledgerValue - catalogValue;
        if (Math.abs(diff) >= TOLERANCE_CNY) {
          difference = { fund: item.nameZh, metric, kind: 'posting', ledgerValue, rowsValue: null, catalogValue, diff };
        }
      }

      if (!difference) continue;
      differences.push(difference);
      (difference.kind === 'posting' ? warnings : notes).push(describeDifference(difference));
    }
  }

  return {
    checked_funds: checkedFunds,
    differences,
    skipped_funds: skippedFunds,
    missing_funds: missingFunds,
    warnings,
    notes,
  };
}

/** A selection as the approval submits it: the asset, and optionally only some of its txns. */
export interface SubmittedAssetSelection {
  asset_code: string;
  txns?: ParsedTxn[];
}

/**
 * The assets an approval submits, shaped like parsed assets: selected codes
 * only, restricted to the selection's txns when it names them, minus txns
 * marked `allowPost: false` (the same rules `applySelected` applies). The
 * two-step review submits a contribution's signed cash delta; it is restored to
 * the parser's positive amount so the parse-time sums apply unchanged.
 */
export function submittedAssets(
  assets: ParsedAsset[],
  codes: string[],
  selections: SubmittedAssetSelection[] | undefined,
): ParsedAsset[] {
  const selected = new Set(codes);
  const txnsByCode = new Map(
    (selections ?? []).filter((s) => s.txns).map((s) => [s.asset_code, s.txns as ParsedTxn[]]),
  );
  return assets
    .filter((a) => selected.has(a.code))
    .map((a) => {
      const txns = txnsByCode.get(a.code);
      if (!txns) return a;
      return {
        ...a,
        txns: txns
          .filter((t) => t.allowPost !== false)
          .map((t) =>
            t.type === 'contribution' && t.valueAmount != null && t.valueAmount < 0
              ? { ...t, valueAmount: -t.valueAmount }
              : t,
          ),
      };
    });
}

function rowKeysByFund(assets: ParsedAsset[], events: ParsedCommitmentEvent[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (fund: string, rowKey: string) => {
    const key = normalizeCanonicalName(fund);
    if (!key) return;
    const set = out.get(key) ?? new Set<string>();
    set.add(rowKey);
    out.set(key, set);
  };
  for (const asset of assets) {
    asset.txns.forEach((t, i) => add(asset.fund, `txn:${asset.code}:${t.sourceRow ?? `#${i}`}`));
  }
  for (const event of events) add(event.fund, `event:${event.sourceRow}`);
  return out;
}

/**
 * Row figures and partial-import funds for a Nanjing approval. Row figures reuse
 * the parse-time reconciliation's sums over the SUBMITTED rows, so a reviewer's
 * edit is expected, not a posting difference. A fund is partial when any of its
 * proposal rows (asset txns or commitment events) was not submitted.
 */
export function nanjingRowCheckInputs(input: {
  catalogItems: FundCatalogItem[];
  proposalAssets: ParsedAsset[];
  proposalEvents: ParsedCommitmentEvent[];
  submittedAssets: ParsedAsset[];
  submittedEvents: ParsedCommitmentEvent[];
}): Required<CatalogCheckInputs> {
  const rowFigures = new Map<string, FundRowFigures>();
  const figuresFor = (fund: string) => {
    const key = normalizeCanonicalName(fund);
    const existing = rowFigures.get(key);
    if (existing) return existing;
    const created = { committed: 0, paidIn: 0, invested: 0 };
    rowFigures.set(key, created);
    return created;
  };
  const results = reconcileNanjingFundLedger(
    input.catalogItems,
    input.submittedAssets,
    input.submittedEvents,
  );
  for (const r of results) {
    if (r.metricName === 'Net Commitment vs Subscribed') figuresFor(r.fund).committed = r.calculatedValue;
    else if (r.metricName === 'Paid-in Capital vs Summary') figuresFor(r.fund).paidIn = r.calculatedValue;
    else if (r.metricName === 'Invested Amount vs Summary') figuresFor(r.fund).invested = r.calculatedValue;
  }

  const partialFunds = new Set<string>();
  const submitted = rowKeysByFund(input.submittedAssets, input.submittedEvents);
  const proposed = rowKeysByFund(input.proposalAssets, input.proposalEvents);
  for (const [fund, keys] of proposed) {
    const sent = submitted.get(fund);
    for (const key of keys) {
      if (!sent?.has(key)) {
        partialFunds.add(fund);
        break;
      }
    }
  }

  return { rowFigures, partialFunds, fundsWithRows: new Set(proposed.keys()) };
}
