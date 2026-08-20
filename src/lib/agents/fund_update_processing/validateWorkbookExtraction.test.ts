import { describe, expect, it } from 'vitest';
import { validateWorkbookExtraction } from './validateWorkbookExtraction';
import type { MergedExtraction } from './mergeWorkbookExtraction';
import type { WorkbookInterpretation } from '@/lib/fund_updates/types';

describe('validateWorkbookExtraction', () => {
  const emptyInterpretation: WorkbookInterpretation = {
    detectedLanguages: ['zh'],
    workbookPurpose: 'Ledger',
    tables: [],
    glossary: [],
    currencies: [],
    summaryTables: [],
    warnings: [],
  };

  it('fails reviewability when a 205-row workbook has only 4 parsed events and 201 unaccounted rows', () => {
    const merged: MergedExtraction = {
      entities: [{ proposalId: 'ent_1', entityType: 'investor', originalName: 'A', englishName: null, aliases: [], existingRecordId: null, matchConfidence: null, sourceLocations: [], warnings: [] }],
      events: [
        { proposalId: 'evt_1', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 2 }, warnings: [] },
        { proposalId: 'evt_2', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 3 }, warnings: [] },
        { proposalId: 'evt_3', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 4 }, warnings: [] },
        { proposalId: 'evt_4', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 5 }, warnings: [] },
      ],
      valuations: [],
      rowAccounting: {
        totalDataRows: 205,
        parsedRows: [2, 3, 4, 5],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 2.0,
        unaccountedRows: Array.from({ length: 201 }, (_, i) => i + 6),
      },
      warnings: [],
    };

    const { validation } = validateWorkbookExtraction(merged, emptyInterpretation);

    expect(validation.isReviewable).toBe(false);
    expect(validation.hardFailures).toHaveLength(2);
    expect(validation.hardFailures[0]).toContain('Incomplete row accounting: 201 data rows were unaccounted for');
    expect(validation.hardFailures[1]).toContain('Coverage is too low: only 4 rows parsed out of 205');
  });

  it('fails reviewability in exclusion abuse case (4 parsed + 201 excluded rows)', () => {
    const excludedRows = Array.from({ length: 201 }, (_, i) => ({
      sheet: 'S',
      row: i + 6,
      reason: 'Irrelevant line item',
    }));

    const merged: MergedExtraction = {
      entities: [{ proposalId: 'ent_1', entityType: 'investor', originalName: 'A', englishName: null, aliases: [], existingRecordId: null, matchConfidence: null, sourceLocations: [], warnings: [] }],
      events: [
        { proposalId: 'evt_1', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 2 }, warnings: [] },
        { proposalId: 'evt_2', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 3 }, warnings: [] },
        { proposalId: 'evt_3', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 4 }, warnings: [] },
        { proposalId: 'evt_4', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 5 }, warnings: [] },
      ],
      valuations: [],
      rowAccounting: {
        totalDataRows: 205,
        parsedRows: [2, 3, 4, 5],
        excludedRows,
        ambiguousRows: [],
        coveragePct: 1.95,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const { validation } = validateWorkbookExtraction(merged, emptyInterpretation);

    expect(validation.isReviewable).toBe(false);
    expect(validation.hardFailures.some((f) => f.includes('Coverage is too low'))).toBe(true);
  });

  it('passes reviewability when row accounting is complete and coverage is high', () => {
    const parsedRows = Array.from({ length: 200 }, (_, i) => i + 2);
    const excludedRows = [{ row: 202, reason: 'Total' }, { row: 203, reason: 'Blank' }, { row: 204, reason: 'Blank' }, { row: 205, reason: 'Blank' }, { row: 206, reason: 'Blank' }];

    const merged: MergedExtraction = {
      entities: [{ proposalId: 'ent_1', entityType: 'investor', originalName: 'A', englishName: null, aliases: [], existingRecordId: null, matchConfidence: null, sourceLocations: [], warnings: [] }],
      events: parsedRows.map((r, i) => ({
        proposalId: `evt_${i + 1}`,
        eventType: 'capital_contribution',
        cashFlowDirection: 'into_fund',
        fromEntityRef: 'A',
        toEntityRef: 'Fund I',
        relatedFundRef: 'Fund I',
        normalizedAmount: 100000,
        normalizedCurrency: 'CNY',
        sourceLocation: { sheet: 'S', row: r },
        warnings: [],
      })),
      valuations: [],
      rowAccounting: {
        totalDataRows: 205,
        parsedRows,
        excludedRows,
        ambiguousRows: [],
        coveragePct: 97.6,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const interpretationWithSummary: WorkbookInterpretation = {
      ...emptyInterpretation,
      summaryTables: [
        {
          tableId: 'sum_1',
          sheetName: 'Summary',
          description: 'Summary table',
          metrics: [
            {
              name: 'Total Fund I Contributions',
              expectedTotal: 20000000, // 200 * 100000
              targetFund: 'Fund I',
            },
          ],
        },
      ],
    };

    const { validation, reconciliation } = validateWorkbookExtraction(merged, interpretationWithSummary);

    expect(validation.isReviewable).toBe(true);
    expect(validation.hardFailures).toHaveLength(0);
    expect(validation.stats.coveragePct).toBeGreaterThanOrEqual(80);
    expect(reconciliation).toHaveLength(1);
    expect(reconciliation[0].isReconciled).toBe(true);
    expect(reconciliation[0].diff).toBe(0);
  });

  it('fails reviewability when duplicate row category assignments exist', () => {
    const merged: MergedExtraction = {
      entities: [{ proposalId: 'ent_1', entityType: 'investor', originalName: 'A', englishName: null, aliases: [], existingRecordId: null, matchConfidence: null, sourceLocations: [], warnings: [] }],
      events: [],
      valuations: [],
      rowAccounting: {
        totalDataRows: 1,
        parsedRows: [2],
        parsedRowItems: [{ sheet: 'S', tableId: 't1', row: 2, rowKey: 'S::t1::2' }],
        excludedRows: [{ sheet: 'S', tableId: 't1', row: 2, reason: 'Contradictory exclusion' }],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const { validation } = validateWorkbookExtraction(merged, emptyInterpretation);

    expect(validation.isReviewable).toBe(false);
    expect(validation.hardFailures.some((f) => f.includes('Duplicate row category assignments detected'))).toBe(true);
  });

  it('fails reviewability when duplicate planned rows are detected', () => {
    const merged: MergedExtraction = {
      entities: [{ proposalId: 'ent_1', entityType: 'investor', originalName: 'A', englishName: null, aliases: [], existingRecordId: null, matchConfidence: null, sourceLocations: [], warnings: [] }],
      events: [
        { proposalId: 'evt_1', eventType: 'capital_contribution', cashFlowDirection: 'into_fund', fromEntityRef: 'A', toEntityRef: 'Fund I', relatedFundRef: 'Fund I', normalizedAmount: 100, normalizedCurrency: 'CNY', sourceLocation: { sheet: 'S', row: 2 }, warnings: [] },
      ],
      valuations: [],
      rowAccounting: {
        totalDataRows: 2,
        plannedRows: [
          { sheet: 'S', tableId: 't1', row: 2, rowKey: 'S::t1::2' },
          { sheet: 'S', tableId: 't1', row: 2, rowKey: 'S::t1::2' }, // Duplicate planned row!
        ],
        parsedRows: [2],
        parsedRowItems: [{ sheet: 'S', tableId: 't1', row: 2, rowKey: 'S::t1::2' }],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
    };

    const { validation } = validateWorkbookExtraction(merged, emptyInterpretation);

    expect(validation.isReviewable).toBe(false);
    expect(validation.hardFailures.some((f) => f.includes('Duplicate planned row keys detected'))).toBe(true);
  });
});
