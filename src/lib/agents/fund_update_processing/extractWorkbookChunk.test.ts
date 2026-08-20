import { describe, expect, it, vi } from 'vitest';
import { extractWorkbookChunk } from './extractWorkbookChunk';
import type { ExtractionChunk } from './planWorkbookExtraction';

describe('extractWorkbookChunk', () => {
  const mockChunk: ExtractionChunk = {
    chunkId: 'chunk_1',
    sheetName: 'Sheet1',
    tableId: 'table_1',
    tablePurpose: 'event_ledger',
    headerRows: [1],
    headerText: '[Header Row 1] 序号 | 主体 | 金额 | 业务',
    glossaryContext: [],
    inputRowNumbers: [2, 3, 4, 5],
    plannedRows: [
      { sheet: 'Sheet1', tableId: 'table_1', row: 2 },
      { sheet: 'Sheet1', tableId: 'table_1', row: 3 },
      { sheet: 'Sheet1', tableId: 'table_1', row: 4 },
      { sheet: 'Sheet1', tableId: 'table_1', row: 5 },
    ],
    rows: [
      { rowNumber: 2, cells: {}, rawValues: [1, 'Entity A', 500, '实缴'], formattedValues: ['1', 'Entity A', '500', '实缴'], hasContent: true },
      { rowNumber: 3, cells: {}, rawValues: [2, 'Entity B', 300, '实缴'], formattedValues: ['2', 'Entity B', '300', '实缴'], hasContent: true },
      { rowNumber: 4, cells: {}, rawValues: ['Subtotal', '', 800, ''], formattedValues: ['Subtotal', '', '800', ''], hasContent: true },
      { rowNumber: 5, cells: {}, rawValues: ['Corrupted', null, null, null], formattedValues: ['Corrupted', '', '', ''], hasContent: true },
    ],
    totalTableRows: 4,
    chunkIndex: 0,
    totalChunks: 1,
  };

  it('extracts chunk events and preserves row accounting', async () => {
    const mockLlm = {
      withStructuredOutput: vi.fn().mockReturnValue({
        invoke: vi.fn().mockResolvedValue({
          entities: [
            { proposalId: 'ent_1', entityType: 'investor', originalName: 'Entity A' },
            { proposalId: 'ent_2', entityType: 'investor', originalName: 'Entity B' },
          ],
          events: [
            {
              proposalId: 'evt_1',
              eventType: 'capital_contribution',
              cashFlowDirection: 'into_fund',
              fromEntityRef: 'Entity A',
              toEntityRef: 'Fund I',
              relatedFundRef: 'Fund I',
              date: '2024-01-15',
              sourceAmount: 500,
              sourceCurrency: 'CNY',
              sourceUnit: '万元',
              amountMultiplier: 10000,
              sourceAction: '实缴',
              sourceLocation: { sheet: 'Sheet1', row: 2 },
              warnings: [],
            },
          ],
          valuations: [],
          parsedRows: [2, 3],
          excludedRows: [{ row: 4, reason: 'Subtotal row' }],
          ambiguousRows: [],
          warnings: [],
        }),
      }),
    };

    const res = await extractWorkbookChunk({
      chunk: mockChunk,
      llmOverride: mockLlm,
    });

    expect(res.entities).toHaveLength(2);
    expect(res.events).toHaveLength(1);
    expect(res.parsedRows).toEqual([2, 3]);
    expect(res.excludedRows).toEqual([{ row: 4, reason: 'Subtotal row', sheet: 'Sheet1' }]);

    // Omitted rows are not silently converted to ambiguous; they remain omitted so merge identifies them as unaccounted
    expect(res.ambiguousRows).toHaveLength(0);
  });
});
