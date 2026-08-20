import {
  formatSourceRowKey,
  type ProposedEventType,
  type ReconciliationResult,
  type SourceRowRef,
  type ValidationResult,
  type WorkbookInterpretation,
} from '@/lib/fund_updates/types';
import type { MergedExtraction } from './mergeWorkbookExtraction';
import { resolveMultiplier } from './normalizeWorkbookExtraction';

export const MINIMUM_REVIEWABLE_COVERAGE_PCT = 80;

function inferEventTypeForMetric(metricName: string, targetEventType?: string): ProposedEventType | null {
  if (targetEventType) return targetEventType as ProposedEventType;
  const name = metricName.toLowerCase();
  if (name.includes('实缴') || name.includes('paid-in') || name.includes('paid in') || name.includes('contribution')) {
    return 'capital_contribution';
  }
  if (name.includes('认缴') || name.includes('committed') || name.includes('commitment')) {
    return 'commitment';
  }
  if (name.includes('投资') || name.includes('invested') || name.includes('investment')) {
    return 'asset_investment';
  }
  if (name.includes('退出') || name.includes('exit') || name.includes('divestment')) {
    return 'asset_exit';
  }
  if (name.includes('分配') || name.includes('distribution')) {
    return 'investor_distribution';
  }
  return null;
}

/**
 * Deterministically validates the extracted workbook data against source-qualified row accounting,
 * disjointness, exclusion abuse prevention, reference integrity, currency consistency, and semantic summary reconciliation.
 */
export function validateWorkbookExtraction(
  merged: MergedExtraction,
  interpretation: WorkbookInterpretation,
): {
  validation: ValidationResult;
  reconciliation: ReconciliationResult[];
} {
  const hardFailures: string[] = [];
  const warnings: string[] = [];
  const reconciliation: ReconciliationResult[] = [];

  const { rowAccounting, events, valuations } = merged;
  const plannedUniverse = new Map<string, SourceRowRef>();
  const duplicatePlannedKeys = new Set<string>();
  if (rowAccounting.plannedRows && rowAccounting.plannedRows.length > 0) {
    for (const pl of rowAccounting.plannedRows) {
      const key = pl.rowKey || formatSourceRowKey(pl.sheet, pl.row, pl.tableId);
      if (plannedUniverse.has(key)) {
        duplicatePlannedKeys.add(key);
      } else {
        plannedUniverse.set(key, pl);
      }
    }
  }

  if (duplicatePlannedKeys.size > 0) {
    hardFailures.push(
      `Duplicate planned row keys detected for ${duplicatePlannedKeys.size} row(s) in extraction plan.`,
    );
  }

  if (
    rowAccounting.plannedRows &&
    rowAccounting.plannedRows.length > 0 &&
    rowAccounting.totalDataRows !== plannedUniverse.size
  ) {
    hardFailures.push(
      `Row accounting totalDataRows (${rowAccounting.totalDataRows}) does not match unique planned rows count (${plannedUniverse.size}).`,
    );
  }

  // 1. Check Disjointness of Row Categories
  const categoryByKey = new Map<string, string>();
  const duplicateKeys = new Set<string>();
  const outOfUniverseRows: string[] = [];

  if (rowAccounting.parsedRowItems && rowAccounting.parsedRowItems.length > 0) {
    for (const p of rowAccounting.parsedRowItems) {
      const key = p.rowKey || formatSourceRowKey(p.sheet, p.row, p.tableId);
      if (categoryByKey.has(key)) {
        duplicateKeys.add(key);
      } else {
        categoryByKey.set(key, 'parsed');
      }
      if (plannedUniverse.size > 0 && !plannedUniverse.has(key)) {
        outOfUniverseRows.push(key);
      }
    }
  } else {
    for (const r of rowAccounting.parsedRows) {
      const key = `default::${r}`;
      if (categoryByKey.has(key)) {
        duplicateKeys.add(key);
      } else {
        categoryByKey.set(key, 'parsed');
      }
    }
  }

  for (const e of rowAccounting.excludedRows) {
    const key = formatSourceRowKey(e.sheet || '', e.row, e.tableId);
    if (categoryByKey.has(key)) {
      duplicateKeys.add(key);
    } else {
      categoryByKey.set(key, 'excluded');
    }
    if (plannedUniverse.size > 0 && !plannedUniverse.has(key)) {
      outOfUniverseRows.push(key);
    }
  }

  for (const a of rowAccounting.ambiguousRows) {
    const key = formatSourceRowKey(a.sheet || '', a.row, a.tableId);
    if (categoryByKey.has(key)) {
      duplicateKeys.add(key);
    } else {
      categoryByKey.set(key, 'ambiguous');
    }
    if (plannedUniverse.size > 0 && !plannedUniverse.has(key)) {
      outOfUniverseRows.push(key);
    }
  }

  if (duplicateKeys.size > 0) {
    hardFailures.push(
      `Duplicate row category assignments detected for ${duplicateKeys.size} row(s). Categories must be strictly mutually disjoint.`,
    );
  }

  if (outOfUniverseRows.length > 0) {
    hardFailures.push(
      `Categorized ${outOfUniverseRows.length} row(s) not present in planned source universe.`,
    );
  }

  // 2. Check Unaccounted Rows (reconstructed deterministically from plannedUniverse if present)
  let unaccountedCount = 0;
  if (plannedUniverse.size > 0) {
    for (const [key] of plannedUniverse) {
      if (!categoryByKey.has(key)) {
        unaccountedCount++;
      }
    }
  } else {
    unaccountedCount = rowAccounting.unaccountedRowItems?.length ?? rowAccounting.unaccountedRows.length;
  }

  if (unaccountedCount > 0) {
    hardFailures.push(
      `Incomplete row accounting: ${unaccountedCount} data rows were unaccounted for in the extraction plan.`,
    );
  }

  const totalRows = plannedUniverse.size > 0 ? plannedUniverse.size : rowAccounting.totalDataRows;
  const parsedCount = rowAccounting.parsedRowItems?.length ?? rowAccounting.parsedRows.length;
  const excludedCount = rowAccounting.excludedRows.length;
  const ambiguousCount = rowAccounting.ambiguousRows.length;

  // 3. Ground Truth Coverage & Exclusion Abuse Prevention
  const coveragePct = totalRows > 0
    ? (parsedCount / totalRows) * 100
    : 100;

  if (totalRows > 0 && coveragePct < MINIMUM_REVIEWABLE_COVERAGE_PCT) {
    hardFailures.push(
      `Coverage is too low: only ${parsedCount} rows parsed out of ${totalRows} data rows (${coveragePct.toFixed(1)}%). Minimum required is ${MINIMUM_REVIEWABLE_COVERAGE_PCT}%.`,
    );
  }

  // 4. Reference, Currency, and Unit Integrity
  const actionCounts: Record<string, number> = {};
  const eventCounts: Record<string, number> = {};
  const fundTotals: Record<string, { count: number; totalAmount: number; currency: string }> = {};

  for (const evt of events) {
    const action = evt.sourceAction || 'unknown';
    actionCounts[action] = (actionCounts[action] || 0) + 1;

    const eventType = evt.eventType;
    eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;

    const fundKey = evt.relatedFundRef || 'Unassigned Fund';
    const curr = evt.normalizedCurrency || 'UNKNOWN';
    const amt = evt.normalizedAmount || 0;

    if (!evt.relatedFundRef || evt.relatedFundRef.trim() === '') {
      hardFailures.push(
        `Event at sheet "${evt.sourceLocation?.sheet || ''}" row ${evt.sourceLocation?.row || 0} has unresolved fund reference.`,
      );
    }

    if (!evt.normalizedCurrency || evt.normalizedCurrency === 'UNKNOWN') {
      hardFailures.push(
        `Event at sheet "${evt.sourceLocation?.sheet || ''}" row ${evt.sourceLocation?.row || 0} has unresolved currency evidence.`,
      );
    }

    if (evt.sourceAmount != null && (evt.normalizedAmount == null || evt.amountMultiplier == null || !evt.sourceUnit)) {
      hardFailures.push(
        `Event at sheet "${evt.sourceLocation?.sheet || ''}" row ${evt.sourceLocation?.row || 0} has unnormalized amount due to missing unit multiplier.`,
      );
    }

    if (!fundTotals[fundKey]) {
      fundTotals[fundKey] = { count: 0, totalAmount: 0, currency: curr };
    }
    fundTotals[fundKey].count++;
    fundTotals[fundKey].totalAmount += amt;

    if (evt.warnings && evt.warnings.length > 0) {
      warnings.push(...evt.warnings.map((w) => `[Row ${evt.sourceLocation?.row || 0}] ${w}`));
    }
  }

  for (const val of valuations) {
    if (val.sourceMarketValue != null && (val.normalizedMarketValue == null || !val.normalizedCurrency)) {
      hardFailures.push(
        `Valuation at sheet "${val.sourceLocation?.sheet || ''}" row ${val.sourceLocation?.row || 0} has unresolved currency or unit multiplier.`,
      );
    }
  }

  // 5. Check Summary Reconciliation by Semantic Event Type & Matching Units
  if (interpretation.summaryTables && interpretation.summaryTables.length > 0) {
    for (const summary of interpretation.summaryTables) {
      for (const metric of summary.metrics) {
        if (metric.expectedTotal != null && Number.isFinite(metric.expectedTotal)) {
          const targetEventType = inferEventTypeForMetric(metric.name, metric.targetEventType);
          const metricMultiplier = metric.multiplier ?? resolveMultiplier(metric.unit) ?? 1;
          const normalizedExpectedTotal = metric.expectedTotal * metricMultiplier;

          let calculated = 0;
          for (const evt of events) {
            // Reconcile matching event type (or all if unspecified)
            if (targetEventType && evt.eventType !== targetEventType) {
              continue;
            }
            if (!metric.targetFund || evt.relatedFundRef?.includes(metric.targetFund)) {
              if (evt.normalizedAmount != null) {
                calculated += evt.normalizedAmount;
              }
            }
          }

          const diff = Math.abs(calculated - normalizedExpectedTotal);
          const diffPct = normalizedExpectedTotal !== 0 ? (diff / normalizedExpectedTotal) * 100 : 0;
          const isReconciled = diffPct < 1.0;

          const detectedCurrency = metric.currency || interpretation.currencies?.[0]?.sourceCurrency || null;

          reconciliation.push({
            metricName: metric.name,
            targetEventType: targetEventType || undefined,
            sourceValue: metric.expectedTotal,
            calculatedValue: calculated,
            diff: Math.round(diff * 100) / 100,
            diffPct: Math.round(diffPct * 100) / 100,
            currency: detectedCurrency,
            unit: metric.unit,
            isReconciled,
            sheet: summary.sheetName,
            notes: isReconciled
              ? 'Reconciled within tolerance'
              : `Discrepancy of ${diffPct.toFixed(2)}% (expected ${normalizedExpectedTotal}, calculated ${calculated})`,
          });

          if (!isReconciled && diffPct > 5.0) {
            warnings.push(
              `Reconciliation discrepancy on ${summary.sheetName} (${metric.name}): expected ${normalizedExpectedTotal}, calculated ${calculated} (diff: ${diffPct.toFixed(1)}%)`,
            );
          }
        }
      }
    }
  }

  const isReviewable = hardFailures.length === 0;

  return {
    validation: {
      isReviewable,
      hardFailures,
      warnings,
      stats: {
        totalRows,
        parsedRowsCount: parsedCount,
        excludedRowsCount: excludedCount,
        ambiguousRowsCount: ambiguousCount,
        coveragePct: Math.round(coveragePct * 10) / 10,
        actionCounts,
        eventCounts,
        fundTotals,
      },
    },
    reconciliation,
  };
}
