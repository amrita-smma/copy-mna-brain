import { describe, expect, it } from 'vitest';
import { mergeWorkbookExtraction } from './mergeWorkbookExtraction';
import type { ChunkExtractionResult } from './schemas';

describe('mergeWorkbookExtraction', () => {
  it('deduplicates entities across chunks and aggregates row accounting', () => {
    const chunk1: ChunkExtractionResult = {
      chunkId: 'chunk_1',
      inputRows: [2, 3],
      entities: [
        {
          proposalId: 'temp_1',
          entityType: 'investor',
          originalName: 'Alpha Corp',
          englishName: 'Alpha',
          sourceLocations: [{ sheet: 'Sheet1', row: 2 }],
        },
      ],
      events: [
        {
          proposalId: 'e1',
          eventType: 'capital_contribution',
          cashFlowDirection: 'into_fund',
          fromEntityRef: 'Alpha Corp',
          toEntityRef: 'Fund I',
          relatedFundRef: 'Fund I',
          sourceAmount: 100,
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      parsedRows: [2],
      excludedRows: [{ row: 3, reason: 'Blank line' }],
      ambiguousRows: [],
      warnings: [],
    };

    const chunk2: ChunkExtractionResult = {
      chunkId: 'chunk_2',
      inputRows: [4, 5],
      entities: [
        {
          proposalId: 'temp_2',
          entityType: 'investor',
          originalName: 'Alpha Corp', // Same entity
          aliases: ['Alpha Corporation'],
          sourceLocations: [{ sheet: 'Sheet1', row: 4 }],
        },
        {
          proposalId: 'temp_3',
          entityType: 'portfolio_company',
          originalName: 'Beta Inc',
          sourceLocations: [{ sheet: 'Sheet1', row: 5 }],
        },
      ],
      events: [
        {
          proposalId: 'e2',
          eventType: 'asset_investment',
          cashFlowDirection: 'out_of_fund',
          fromEntityRef: 'Fund I',
          toEntityRef: 'Beta Inc',
          relatedFundRef: 'Fund I',
          sourceAmount: 200,
          sourceLocation: { sheet: 'Sheet1', row: 5 },
          warnings: [],
        },
      ],
      valuations: [],
      parsedRows: [4, 5],
      excludedRows: [],
      ambiguousRows: [],
      warnings: [],
    };

    const merged = mergeWorkbookExtraction([chunk1, chunk2], 4);

    // Entities deduplicated: Alpha Corp and Beta Inc
    expect(merged.entities).toHaveLength(2);
    const alpha = merged.entities.find((e) => e.originalName === 'Alpha Corp');
    expect(alpha?.proposalId).toBe('ent_1');
    expect(alpha?.aliases).toContain('Alpha Corporation');
    expect(alpha?.sourceLocations).toHaveLength(2);

    const beta = merged.entities.find((e) => e.originalName === 'Beta Inc');
    expect(beta?.proposalId).toBe('ent_2');

    // Events have stable proposal IDs
    expect(merged.events).toHaveLength(2);
    expect(merged.events[0].proposalId).toBe('evt_1');
    expect(merged.events[1].proposalId).toBe('evt_2');

    // Row accounting
    expect(merged.rowAccounting.totalDataRows).toBe(4);
    expect(merged.rowAccounting.parsedRows).toEqual([2, 4, 5]);
    expect(merged.rowAccounting.excludedRows).toEqual([
      { sheet: '', tableId: '', row: 3, reason: 'Blank line' },
    ]);
    expect(merged.rowAccounting.coveragePct).toBe(75);
  });

  it('keeps identical row numbers on different sheets distinct in row accounting', () => {
    const sheet1Chunk: ChunkExtractionResult = {
      chunkId: 's1_c1',
      sheetName: 'Sheet A',
      tableId: 'tbl_a',
      inputRows: [2, 3],
      entities: [],
      events: [
        {
          proposalId: 'e1',
          eventType: 'capital_contribution',
          sourceAmount: 100,
          sourceLocation: { sheet: 'Sheet A', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      parsedRows: [2],
      excludedRows: [{ sheet: 'Sheet A', row: 3, reason: 'Subtotal' }],
      ambiguousRows: [],
      warnings: [],
    };

    const sheet2Chunk: ChunkExtractionResult = {
      chunkId: 's2_c1',
      sheetName: 'Sheet B',
      tableId: 'tbl_b',
      inputRows: [2, 3],
      entities: [],
      events: [
        {
          proposalId: 'e2',
          eventType: 'asset_investment',
          sourceAmount: 500,
          sourceLocation: { sheet: 'Sheet B', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      parsedRows: [2, 3],
      excludedRows: [],
      ambiguousRows: [],
      warnings: [],
    };

    const plannedRows = [
      { sheet: 'Sheet A', tableId: 'tbl_a', row: 2 },
      { sheet: 'Sheet A', tableId: 'tbl_a', row: 3 },
      { sheet: 'Sheet B', tableId: 'tbl_b', row: 2 },
      { sheet: 'Sheet B', tableId: 'tbl_b', row: 3 },
    ];

    const merged = mergeWorkbookExtraction([sheet1Chunk, sheet2Chunk], plannedRows);

    expect(merged.rowAccounting.totalDataRows).toBe(4);
    expect(merged.rowAccounting.parsedRowItems).toHaveLength(3); // Sheet A row 2, Sheet B row 2, Sheet B row 3
    expect(merged.rowAccounting.excludedRows).toHaveLength(1); // Sheet A row 3
    expect(merged.rowAccounting.unaccountedRowItems).toBeUndefined();
    expect(merged.rowAccounting.coveragePct).toBe(75);
  });

  it('detects omitted rows and populates unaccounted rows from planned universe', () => {
    const chunk: ChunkExtractionResult = {
      chunkId: 'c1',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [2, 3, 4],
      entities: [],
      events: [],
      valuations: [],
      parsedRows: [2],
      excludedRows: [], // Row 3 and Row 4 completely omitted by model!
      ambiguousRows: [],
      warnings: [],
    };

    const plannedRows = [
      { sheet: 'Sheet1', tableId: 't1', row: 2 },
      { sheet: 'Sheet1', tableId: 't1', row: 3 },
      { sheet: 'Sheet1', tableId: 't1', row: 4 },
    ];

    const merged = mergeWorkbookExtraction([chunk], plannedRows);

    expect(merged.rowAccounting.parsedRows).toEqual([2]);
    expect(merged.rowAccounting.unaccountedRowItems).toHaveLength(2);
    expect(merged.rowAccounting.unaccountedRows).toEqual([3, 4]);
  });

  it('enforces precedence for row parsed+ambiguous when event is extracted', () => {
    const chunk: ChunkExtractionResult = {
      chunkId: 'c1',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [2],
      entities: [
        {
          proposalId: 'ent_1',
          entityType: 'investor',
          originalName: 'Alpha Corp',
          sourceLocations: [{ sheet: 'Sheet1', row: 2 }],
        },
      ],
      events: [
        {
          proposalId: 'e1',
          eventType: 'capital_contribution',
          cashFlowDirection: 'into_fund',
          fromEntityRef: 'Alpha Corp',
          toEntityRef: 'Fund I',
          relatedFundRef: 'Fund I',
          sourceAmount: 100,
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ],
      valuations: [],
      parsedRows: [2],
      excludedRows: [],
      ambiguousRows: [{ sheet: 'Sheet1', row: 2, reason: 'Uncertain counterparty classification' }],
      warnings: [],
    };

    const plannedRows = [{ sheet: 'Sheet1', tableId: 't1', row: 2 }];
    const merged = mergeWorkbookExtraction([chunk], plannedRows);

    // Parsed wins: in parsedRowItems, not in ambiguousRows
    expect(merged.rowAccounting.parsedRows).toEqual([2]);
    expect(merged.rowAccounting.parsedRowItems).toHaveLength(1);
    expect(merged.rowAccounting.ambiguousRows).toHaveLength(0);
    expect(merged.rowAccounting.excludedRows).toHaveLength(0);
    expect(merged.rowAccounting.coveragePct).toBe(100);

    // Ambiguity reason retained as warning
    expect(
      merged.warnings.some((w) =>
        w.includes('was categorized as both parsed and ambiguous') &&
        w.includes('Uncertain counterparty classification') &&
        w.includes('parsed event takes precedence'),
      ),
    ).toBe(true);
  });

  it('enforces precedence for row parsed+excluded when event is extracted', () => {
    const chunk: ChunkExtractionResult = {
      chunkId: 'c1',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [3],
      entities: [
        {
          proposalId: 'ent_1',
          entityType: 'portfolio_company',
          originalName: 'Target Ltd',
          sourceLocations: [{ sheet: 'Sheet1', row: 3 }],
        },
      ],
      events: [
        {
          proposalId: 'e1',
          eventType: 'asset_investment',
          cashFlowDirection: 'out_of_fund',
          fromEntityRef: 'Fund I',
          toEntityRef: 'Target Ltd',
          relatedFundRef: 'Fund I',
          sourceAmount: 500,
          sourceLocation: { sheet: 'Sheet1', row: 3 },
          warnings: [],
        },
      ],
      valuations: [],
      parsedRows: [3],
      excludedRows: [{ sheet: 'Sheet1', row: 3, reason: 'Flagged as potential subtotal memo row' }],
      ambiguousRows: [],
      warnings: [],
    };

    const plannedRows = [{ sheet: 'Sheet1', tableId: 't1', row: 3 }];
    const merged = mergeWorkbookExtraction([chunk], plannedRows);

    // Parsed wins: in parsedRowItems, not in excludedRows
    expect(merged.rowAccounting.parsedRows).toEqual([3]);
    expect(merged.rowAccounting.parsedRowItems).toHaveLength(1);
    expect(merged.rowAccounting.excludedRows).toHaveLength(0);
    expect(merged.rowAccounting.ambiguousRows).toHaveLength(0);
    expect(merged.rowAccounting.coveragePct).toBe(100);

    // Exclusion reason retained as warning
    expect(
      merged.warnings.some((w) =>
        w.includes('was categorized as both parsed and excluded') &&
        w.includes('Flagged as potential subtotal memo row') &&
        w.includes('parsed event takes precedence'),
      ),
    ).toBe(true);
  });

  it('preserves contradictory categories in rowAccounting when parsed has no extracted event', () => {
    const chunk1: ChunkExtractionResult = {
      chunkId: 'c1',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [4],
      entities: [],
      events: [], // NO event extracted!
      valuations: [],
      parsedRows: [4],
      excludedRows: [],
      ambiguousRows: [],
      warnings: [],
    };

    const chunk2: ChunkExtractionResult = {
      chunkId: 'c2',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [4],
      entities: [],
      events: [],
      valuations: [],
      parsedRows: [],
      excludedRows: [],
      ambiguousRows: [{ sheet: 'Sheet1', row: 4, reason: 'Unparseable noise row' }],
      warnings: [],
    };

    const plannedRows = [{ sheet: 'Sheet1', tableId: 't1', row: 4 }];
    const merged = mergeWorkbookExtraction([chunk1, chunk2], plannedRows);

    // Both categories preserved so validator triggers hard failure
    expect(merged.rowAccounting.parsedRows).toEqual([4]);
    expect(merged.rowAccounting.ambiguousRows).toHaveLength(1);
    expect(merged.rowAccounting.ambiguousRows[0].reason).toBe('Unparseable noise row');
  });

  it('preserves contradictory categories for excluded+ambiguous with no parsed event', () => {
    const chunk1: ChunkExtractionResult = {
      chunkId: 'c1',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [5],
      entities: [],
      events: [],
      valuations: [],
      parsedRows: [],
      excludedRows: [{ sheet: 'Sheet1', row: 5, reason: 'Header separator' }],
      ambiguousRows: [],
      warnings: [],
    };

    const chunk2: ChunkExtractionResult = {
      chunkId: 'c2',
      sheetName: 'Sheet1',
      tableId: 't1',
      inputRows: [5],
      entities: [],
      events: [],
      valuations: [],
      parsedRows: [],
      excludedRows: [],
      ambiguousRows: [{ sheet: 'Sheet1', row: 5, reason: 'Possible unformatted summary' }],
      warnings: [],
    };

    const plannedRows = [{ sheet: 'Sheet1', tableId: 't1', row: 5 }];
    const merged = mergeWorkbookExtraction([chunk1, chunk2], plannedRows);

    expect(merged.rowAccounting.excludedRows).toHaveLength(1);
    expect(merged.rowAccounting.ambiguousRows).toHaveLength(1);
  });

  it('handles 205 parsed rows with 9 ambiguous rows that have parsed events', () => {
    const totalRows = 205;
    const ambiguousIndices = [10, 25, 40, 65, 80, 110, 145, 170, 200];
    const plannedRows = Array.from({ length: totalRows }, (_, i) => ({
      sheet: '基金流水明细',
      tableId: 'tbl_1',
      row: i + 2,
    }));

    const events = plannedRows.map((p, i) => ({
      proposalId: `e_${i}`,
      eventType: 'capital_contribution' as const,
      cashFlowDirection: 'into_fund' as const,
      fromEntityRef: `Investor ${i}`,
      toEntityRef: 'Fund A',
      relatedFundRef: 'Fund A',
      sourceAmount: 1000,
      sourceLocation: { sheet: p.sheet, row: p.row },
      warnings: [],
    }));

    const parsedRows = plannedRows.map((p) => p.row);
    const ambiguousRows = ambiguousIndices.map((idx) => ({
      sheet: '基金流水明细',
      row: idx,
      reason: `LLM ambiguity remark for row ${idx}`,
    }));

    const chunk: ChunkExtractionResult = {
      chunkId: 'c1',
      sheetName: '基金流水明细',
      tableId: 'tbl_1',
      inputRows: parsedRows,
      entities: [],
      events,
      valuations: [],
      parsedRows,
      excludedRows: [],
      ambiguousRows,
      warnings: [],
    };

    const merged = mergeWorkbookExtraction([chunk], plannedRows);

    expect(merged.rowAccounting.parsedRows).toHaveLength(205);
    expect(merged.rowAccounting.parsedRowItems).toHaveLength(205);
    expect(merged.rowAccounting.ambiguousRows).toHaveLength(0);
    expect(merged.rowAccounting.excludedRows).toHaveLength(0);
    expect(merged.rowAccounting.coveragePct).toBe(100);
    expect(merged.rowAccounting.unaccountedRows).toHaveLength(0);
    expect(merged.warnings).toHaveLength(9);
  });
});
