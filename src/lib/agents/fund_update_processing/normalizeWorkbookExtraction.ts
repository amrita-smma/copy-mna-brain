import type {
  ProposedEvent,
  ProposedValuation,
  WorkbookInterpretation,
} from '@/lib/fund_updates/types';
import type { MergedExtraction } from './mergeWorkbookExtraction';

const ACTION_MAP: Record<
  string,
  {
    eventType: ProposedEvent['eventType'];
    direction: ProposedEvent['cashFlowDirection'];
  }
> = {
  实缴: { eventType: 'capital_contribution', direction: 'into_fund' },
  认缴: { eventType: 'commitment', direction: 'non_cash' },
  投资: { eventType: 'asset_investment', direction: 'out_of_fund' },
  减资: { eventType: 'commitment_reduction', direction: 'out_of_fund' },
  退出: { eventType: 'asset_exit', direction: 'into_fund' },
  分配: { eventType: 'investor_distribution', direction: 'out_of_fund' },
  实缴调整: { eventType: 'capital_adjustment', direction: 'into_fund' },
  commitment: { eventType: 'commitment', direction: 'non_cash' },
  capital_contribution: { eventType: 'capital_contribution', direction: 'into_fund' },
  contribution: { eventType: 'capital_contribution', direction: 'into_fund' },
  distribution: { eventType: 'investor_distribution', direction: 'out_of_fund' },
  investment: { eventType: 'asset_investment', direction: 'out_of_fund' },
  exit: { eventType: 'asset_exit', direction: 'into_fund' },
  reduction: { eventType: 'commitment_reduction', direction: 'out_of_fund' },
};

export function resolveMultiplier(unitStr?: string | null): number | null {
  if (!unitStr) return null;
  const u = unitStr.trim().toLowerCase();
  if (u.includes('万元') || u === '万' || u === '萬') return 10000;
  if (u.includes('亿元') || u === '亿' || u === '億' || u === '억') return 100000000;
  if (u === 'mn' || u.includes('million') || u.includes('百万')) return 1000000;
  if (u === 'bn' || u.includes('billion') || u.includes('十亿')) return 1000000000;
  if (u === 'k' || u.includes('thousand') || u.includes('千')) return 1000;
  if (u === '1' || u === '元' || u === 'units' || u === 'usd' || u === 'cny') return 1;
  return null;
}

/**
 * Normalizes date string into YYYY-MM-DD.
 * Returns null if string is not a valid date format.
 */
export function normalizeDate(dateVal?: unknown): { isoDate: string | null; warning?: string } {
  if (dateVal == null || dateVal === '') return { isoDate: null };
  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    // Check YYYY-MM-DD
    const match = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (match) {
      const year = match[1];
      const month = match[2].padStart(2, '0');
      const day = match[3].padStart(2, '0');
      return { isoDate: `${year}-${month}-${day}` };
    }
    // Try native Date parse
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
      return { isoDate: d.toISOString().slice(0, 10) };
    }
    return {
      isoDate: null,
      warning: `Date "${trimmed}" could not be parsed into YYYY-MM-DD`,
    };
  }
  if (dateVal instanceof Date && !Number.isNaN(dateVal.getTime())) {
    return { isoDate: dateVal.toISOString().slice(0, 10) };
  }
  return { isoDate: null, warning: `Invalid date value: ${String(dateVal)}` };
}

/**
 * Deterministically normalizes extracted amounts, currencies, units, dates, and event types in code.
 * Derives multipliers in code from source/header evidence. Never defaults missing currency/units to CNY/万元.
 * Disregards conflicting model amountMultiplier values and emits warnings.
 */
export function normalizeWorkbookExtraction(
  merged: MergedExtraction,
  interpretation: WorkbookInterpretation,
): MergedExtraction {
  const currencyBySheet = new Map<string, { currency: string | null; unit: string | null; multiplier: number | null }>();
  for (const c of interpretation.currencies || []) {
    const mult = resolveMultiplier(c.sourceUnit) ?? (c.multiplier ?? null);
    if (c.evidence?.sheet) {
      currencyBySheet.set(c.evidence.sheet.toLowerCase().trim(), {
        currency: c.sourceCurrency || null,
        unit: c.sourceUnit || null,
        multiplier: mult,
      });
    }
  }

  const defaultCurrencyInfo = interpretation.currencies && interpretation.currencies.length > 0
    ? {
        currency: interpretation.currencies[0].sourceCurrency || null,
        unit: interpretation.currencies[0].sourceUnit || null,
        multiplier: resolveMultiplier(interpretation.currencies[0].sourceUnit) ?? (interpretation.currencies[0].multiplier ?? null),
      }
    : null;

  for (const evt of merged.events) {
    const sheetKey = (evt.sourceLocation?.sheet || '').toLowerCase().trim();
    const sheetCurrencyInfo = currencyBySheet.get(sheetKey) || defaultCurrencyInfo;

    // 1. Action mapping & cash flow direction
    if (evt.sourceAction) {
      const cleanAction = evt.sourceAction.trim();
      const mapped = ACTION_MAP[cleanAction] || ACTION_MAP[cleanAction.toLowerCase()];
      if (mapped) {
        evt.eventType = mapped.eventType;
        if (!evt.cashFlowDirection || evt.cashFlowDirection === 'unknown') {
          evt.cashFlowDirection = mapped.direction;
        }
      }
    }

    // 2. Unit and multiplier derivation in code
    const explicitUnitMultiplier = resolveMultiplier(evt.sourceUnit);
    let resolvedMultiplier: number | null = null;
    let resolvedUnit: string | null = null;
    let resolvedCurrency: string | null = null;

    if (explicitUnitMultiplier != null) {
      resolvedMultiplier = explicitUnitMultiplier;
      resolvedUnit = evt.sourceUnit || null;
    } else if (sheetCurrencyInfo) {
      resolvedMultiplier = sheetCurrencyInfo.multiplier;
      resolvedUnit = sheetCurrencyInfo.unit;
    }

    if (evt.sourceCurrency) {
      resolvedCurrency = evt.sourceCurrency;
    } else if (sheetCurrencyInfo) {
      resolvedCurrency = sheetCurrencyInfo.currency;
    }

    // Check if model sent a conflicting amountMultiplier
    if (evt.amountMultiplier != null && resolvedMultiplier != null && evt.amountMultiplier !== resolvedMultiplier) {
      evt.warnings.push(
        `Model amountMultiplier (${evt.amountMultiplier}) contradicted code-derived multiplier (${resolvedMultiplier}); using code-derived multiplier.`,
      );
    }

    evt.sourceUnit = resolvedUnit;
    evt.amountMultiplier = resolvedMultiplier;
    evt.sourceCurrency = resolvedCurrency;
    evt.normalizedCurrency = resolvedCurrency;

    // 3. Amount calculation
    if (evt.sourceAmount != null && Number.isFinite(evt.sourceAmount) && resolvedMultiplier != null) {
      const scaled = evt.sourceAmount * resolvedMultiplier;
      evt.normalizedAmount = Math.round(scaled * 100) / 100;
    } else if (evt.sourceAmount != null && resolvedMultiplier == null) {
      evt.normalizedAmount = null;
      evt.warnings.push(`Amount ${evt.sourceAmount} could not be normalized because unit multiplier is unresolved.`);
    } else {
      evt.normalizedAmount = null;
    }

    // 4. Date normalization
    const dateResult = normalizeDate(evt.date);
    if (dateResult.warning) {
      evt.warnings.push(dateResult.warning);
    }
    evt.date = dateResult.isoDate;
  }

  // Normalize valuations
  for (const val of merged.valuations) {
    const sheetKey = (val.sourceLocation?.sheet || '').toLowerCase().trim();
    const sheetCurrencyInfo = currencyBySheet.get(sheetKey) || defaultCurrencyInfo;

    const resolvedMultiplier = sheetCurrencyInfo?.multiplier ?? null;
    const resolvedCurrency = val.sourceCurrency || sheetCurrencyInfo?.currency || null;

    val.sourceCurrency = resolvedCurrency;
    val.normalizedCurrency = resolvedCurrency;

    if (val.sourceMarketValue != null && Number.isFinite(val.sourceMarketValue) && resolvedMultiplier != null) {
      const scaled = val.sourceMarketValue * resolvedMultiplier;
      val.normalizedMarketValue = Math.round(scaled * 100) / 100;
    } else {
      val.normalizedMarketValue = null;
      if (val.sourceMarketValue != null && resolvedMultiplier == null) {
        val.warnings.push(`Market value ${val.sourceMarketValue} could not be normalized because unit multiplier is unresolved.`);
      }
    }

    const dateResult = normalizeDate(val.asOfDate);
    if (dateResult.warning) val.warnings.push(dateResult.warning);
    val.asOfDate = dateResult.isoDate;
  }

  return merged;
}
