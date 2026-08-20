import { describe, expect, it } from 'vitest';
import {
  normalizeDate,
  normalizeWorkbookExtraction,
  resolveMultiplier,
} from './normalizeWorkbookExtraction';
import { validateWorkbookExtraction } from './validateWorkbookExtraction';
import type { MergedExtraction } from './mergeWorkbookExtraction';
import type { WorkbookInterpretation } from '@/lib/fund_updates/types';

describe('normalizeWorkbookExtraction', () => {
  it('resolves currency multipliers accurately', () => {
    expect(resolveMultiplier('万元')).toBe(10000);
    expect(resolveMultiplier('万')).toBe(10000);
    expect(resolveMultiplier('亿元')).toBe(100000000);
    expect(resolveMultiplier('mn')).toBe(1000000);
    expect(resolveMultiplier('k')).toBe(1000);
    expect(resolveMultiplier('元')).toBe(1);
    expect(resolveMultiplier(null)).toBeNull();
    expect(resolveMultiplier(undefined)).toBeNull();
  });

  it('normalizes dates and preserves warnings for invalid dates without dropping', () => {
    expect(normalizeDate('2024-01-15').isoDate).toBe('2024-01-15');
    expect(normalizeDate('2024/05/20').isoDate).toBe('2024-05-20');
    expect(normalizeDate('2024.12.01').isoDate).toBe('2024-12-01');

    const invalid = normalizeDate('not-a-date');
    expect(invalid.isoDate).toBeNull();
    expect(invalid.warning).toBeDefined();
  });

  it('performs deterministic multiplier scaling and action normalization in code', () => {
    const merged: MergedExtraction = {
      entities: [
        {
          proposalId: 'ent_1',
          entityType: 'investor',
          originalName: '高亚投资',
          englishName: null,
          aliases: [],
          existingRecordId: null,
          matchConfidence: null,
          sourceLocations: [],
          warnings: [],
        },
      ],
      events: [
        {
          proposalId: 'evt_1',
          eventType: 'other',
          cashFlowDirection: 'unknown',
          fromEntityRef: '高亚投资',
          toEntityRef: 'Fund A',
          relatedFundRef: 'Fund A', // Should NOT become Others
          date: '2024.03.15',
          sourceAmount: 150.5,
          sourceCurrency: 'CNY',
          sourceUnit: '万元',
          amountMultiplier: null,
          normalizedAmount: null,
          normalizedCurrency: null,
          sourceAction: '实缴',
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      rowAccounting: {
        totalDataRows: 1,
        parsedRows: [2],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const interpretation: WorkbookInterpretation = {
      detectedLanguages: ['zh'],
      workbookPurpose: 'Ledger',
      tables: [],
      glossary: [],
      currencies: [
        { sourceCurrency: 'CNY', sourceUnit: '万元', multiplier: 10000 },
      ],
      summaryTables: [],
      warnings: [],
    };

    const res = normalizeWorkbookExtraction(merged, interpretation);

    expect(res.events[0].eventType).toBe('capital_contribution');
    expect(res.events[0].cashFlowDirection).toBe('into_fund');
    expect(res.events[0].date).toBe('2024-03-15');
    expect(res.events[0].amountMultiplier).toBe(10000);
    expect(res.events[0].normalizedAmount).toBe(1505000); // 150.5 * 10000
    expect(res.events[0].relatedFundRef).toBe('Fund A');
  });

  it('ignores conflicting model amountMultiplier and emits a warning', () => {
    const merged: MergedExtraction = {
      entities: [],
      events: [
        {
          proposalId: 'evt_1',
          eventType: 'capital_contribution',
          sourceAmount: 100,
          sourceCurrency: 'CNY',
          sourceUnit: '万元',
          amountMultiplier: 1, // Conflicting model multiplier!
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      rowAccounting: {
        totalDataRows: 1,
        parsedRows: [2],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const interpretation: WorkbookInterpretation = {
      detectedLanguages: ['zh'],
      workbookPurpose: 'Ledger',
      tables: [],
      glossary: [],
      currencies: [
        { sourceCurrency: 'CNY', sourceUnit: '万元', multiplier: 10000 },
      ],
      summaryTables: [],
      warnings: [],
    };

    const res = normalizeWorkbookExtraction(merged, interpretation);

    expect(res.events[0].amountMultiplier).toBe(10000);
    expect(res.events[0].normalizedAmount).toBe(1000000); // 100 * 10000
    expect(res.events[0].warnings.some((w) => w.includes('Model amountMultiplier'))).toBe(true);
  });

  it('never defaults unresolved unit to 1 and leaves amount unnormalized with warnings', () => {
    const merged: MergedExtraction = {
      entities: [],
      events: [
        {
          proposalId: 'evt_1',
          eventType: 'capital_contribution',
          sourceAmount: 500,
          sourceCurrency: 'CNY',
          sourceUnit: null, // Missing unit!
          amountMultiplier: null,
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      rowAccounting: {
        totalDataRows: 1,
        parsedRows: [2],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const interpretation: WorkbookInterpretation = {
      detectedLanguages: ['zh'],
      workbookPurpose: 'Ledger',
      tables: [],
      glossary: [],
      currencies: [], // No currencies/units interpreted
      summaryTables: [],
      warnings: [],
    };

    const res = normalizeWorkbookExtraction(merged, interpretation);

    expect(res.events[0].amountMultiplier).toBeNull();
    expect(res.events[0].normalizedAmount).toBeNull();
    expect(res.events[0].warnings.some((w) => w.includes('could not be normalized'))).toBe(true);

    const validated = validateWorkbookExtraction(res, interpretation);
    expect(validated.validation.isReviewable).toBe(false);
    expect(validated.validation.hardFailures.some((f: string) => f.includes('missing unit multiplier'))).toBe(true);
  });

  it('proves a CNY valuation under 万元 scales by 10,000 and missing unit stays unresolved', () => {
    const merged: MergedExtraction = {
      entities: [
        {
          proposalId: 'ent_1',
          entityType: 'portfolio_company',
          originalName: 'Tech Co',
          englishName: null,
          aliases: [],
          existingRecordId: null,
          matchConfidence: null,
          sourceLocations: [],
          warnings: [],
        },
      ],
      events: [],
      valuations: [
        {
          proposalId: 'val_1',
          entityRef: 'Tech Co',
          asOfDate: '2024-06-30',
          sourceMarketValue: 500, // 500 万元 = 5,000,000 CNY
          sourceCurrency: 'CNY',
          normalizedMarketValue: null,
          normalizedCurrency: null,
          sourceLocation: { sheet: 'Valuations', row: 5 },
          warnings: [],
        },
      ],
      rowAccounting: {
        totalDataRows: 1,
        plannedRows: [{ sheet: 'Valuations', row: 5, rowKey: 'Valuations::::5' }],
        parsedRows: [5],
        parsedRowItems: [{ sheet: 'Valuations', row: 5, rowKey: 'Valuations::::5' }],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const interpretationWithUnit: WorkbookInterpretation = {
      detectedLanguages: ['zh'],
      workbookPurpose: 'Valuation Sheet',
      tables: [],
      glossary: [],
      currencies: [
        {
          sourceCurrency: 'CNY',
          sourceUnit: '万元',
          multiplier: 10000,
          evidence: { sheet: 'Valuations' },
        },
      ],
      summaryTables: [],
      warnings: [],
    };

    // 1. With 万元 sheet evidence -> scales by 10,000 (500 * 10,000 = 5,000,000)
    const scaledResult = normalizeWorkbookExtraction(
      JSON.parse(JSON.stringify(merged)),
      interpretationWithUnit,
    );
    expect(scaledResult.valuations[0].normalizedCurrency).toBe('CNY');
    expect(scaledResult.valuations[0].normalizedMarketValue).toBe(5000000);

    // 2. Missing unit evidence -> stays unresolved (null) and hard fails validation
    const interpretationWithoutUnit: WorkbookInterpretation = {
      detectedLanguages: ['zh'],
      workbookPurpose: 'Valuation Sheet',
      tables: [],
      glossary: [],
      currencies: [], // Missing unit evidence
      summaryTables: [],
      warnings: [],
    };

    const unscaledResult = normalizeWorkbookExtraction(
      JSON.parse(JSON.stringify(merged)),
      interpretationWithoutUnit,
    );
    expect(unscaledResult.valuations[0].normalizedMarketValue).toBeNull();
    expect(
      unscaledResult.valuations[0].warnings.some((w) =>
        w.includes('could not be normalized because unit multiplier is unresolved'),
      ),
    ).toBe(true);

    const validated = validateWorkbookExtraction(unscaledResult, interpretationWithoutUnit);
    expect(validated.validation.isReviewable).toBe(false);
    expect(
      validated.validation.hardFailures.some((f) =>
        f.includes('unresolved currency or unit multiplier'),
      ),
    ).toBe(true);
  });
});
