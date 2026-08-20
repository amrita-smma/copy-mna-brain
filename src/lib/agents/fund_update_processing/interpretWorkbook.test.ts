import { describe, expect, it, vi } from 'vitest';
import { buildWorkbookManifest, interpretWorkbook } from './interpretWorkbook';
import type { SerializedWorkbook } from '@/lib/workbook/types';

describe('interpretWorkbook', () => {
  const mockWorkbook: SerializedWorkbook = {
    fileName: 'fund_ledger.xlsx',
    sheets: [
      {
        name: '基金流水明细',
        id: 1,
        rowCount: 220,
        columnCount: 14,
        nonEmptyRowCount: 205,
        mergedRanges: [],
        rows: [
          {
            rowNumber: 1,
            cells: {},
            rawValues: ['序号', '主体名称', '金额（万元）', '业务性质'],
            formattedValues: ['序号', '主体名称', '金额（万元）', '业务性质'],
            hasContent: true,
          },
          {
            rowNumber: 2,
            cells: {},
            rawValues: [1, '高亚投资', 15000, '实缴'],
            formattedValues: ['1', '高亚投资', '15000', '实缴'],
            hasContent: true,
          },
        ],
      },
    ],
  };

  it('builds a concise workbook manifest for the LLM prompt', () => {
    const manifest = buildWorkbookManifest(mockWorkbook);
    expect(manifest).toContain('fund_ledger.xlsx');
    expect(manifest).toContain('基金流水明细');
    expect(manifest).toContain('高亚投资');
    expect(manifest).toContain('15000');
  });

  it('invokes structured output and returns parsed WorkbookInterpretation', async () => {
    const mockLlm = {
      withStructuredOutput: vi.fn().mockReturnValue({
        invoke: vi.fn().mockResolvedValue({
          detectedLanguages: ['zh', 'en'],
          workbookPurpose: 'Fund ledger and cash flow tracking',
          tables: [
            {
              tableId: 'table_1',
              sheetName: '基金流水明细',
              purpose: 'event_ledger',
              headerRows: [1],
              dataStartRow: 2,
              dataEndRow: 220,
              columns: [
                { column: 'A', sourceHeader: '序号', semanticRole: 'id', required: true },
                { column: 'B', sourceHeader: '主体名称', semanticRole: 'entity_name', required: true },
                { column: 'C', sourceHeader: '金额（万元）', semanticRole: 'amount', required: true },
                { column: 'D', sourceHeader: '业务性质', semanticRole: 'action', required: true },
              ],
              confidence: 0.95,
            },
          ],
          glossary: [{ term: '实缴', definition: 'Capital contribution paid in' }],
          currencies: [
            {
              sourceCurrency: 'CNY',
              sourceUnit: '万元',
              multiplier: 10000,
              evidence: { sheet: '基金流水明细', cell: 'C1', text: '金额（万元）' },
            },
          ],
          summaryTables: [],
          warnings: [],
        }),
      }),
    };

    const res = await interpretWorkbook({
      workbook: mockWorkbook,
      llmOverride: mockLlm,
    });

    expect(res.detectedLanguages).toContain('zh');
    expect(res.tables).toHaveLength(1);
    expect(res.tables[0].purpose).toBe('event_ledger');
    expect(res.currencies[0].multiplier).toBe(10000);
    expect(res.currencies[0].sourceUnit).toBe('万元');
  });
});
