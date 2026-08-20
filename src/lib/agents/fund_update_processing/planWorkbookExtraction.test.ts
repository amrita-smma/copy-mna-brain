import { describe, expect, it } from 'vitest';
import { planWorkbookExtraction } from './planWorkbookExtraction';
import type { SerializedRow, SerializedWorkbook } from '@/lib/workbook/types';
import type { WorkbookInterpretation } from '@/lib/fund_updates/types';

describe('planWorkbookExtraction', () => {
  it('creates table-aware bounded chunks with stable row numbers and headers', () => {
    const rows: SerializedRow[] = [
      {
        rowNumber: 1,
        cells: {},
        rawValues: ['序号', '名称', '金额'],
        formattedValues: ['序号', '名称', '金额'],
        hasContent: true,
      },
    ];

    // Generate 205 data rows (rows 2 to 206)
    for (let i = 2; i <= 206; i++) {
      rows.push({
        rowNumber: i,
        cells: {},
        rawValues: [i - 1, `Entity ${i - 1}`, 1000 * (i - 1)],
        formattedValues: [String(i - 1), `Entity ${i - 1}`, String(1000 * (i - 1))],
        hasContent: true,
      });
    }

    const workbook: SerializedWorkbook = {
      fileName: '205_rows.xlsx',
      sheets: [
        {
          name: '基金流水明细',
          id: 1,
          rowCount: 206,
          columnCount: 3,
          nonEmptyRowCount: 206,
          mergedRanges: [],
          rows,
        },
      ],
    };

    const interpretation: WorkbookInterpretation = {
      detectedLanguages: ['zh'],
      workbookPurpose: 'Ledger',
      tables: [
        {
          tableId: 'table_1',
          sheetName: '基金流水明细',
          purpose: 'event_ledger',
          headerRows: [1],
          dataStartRow: 2,
          dataEndRow: 206,
          columns: [],
          confidence: 1.0,
        },
      ],
      glossary: [{ term: '实缴', definition: 'contribution' }],
      currencies: [
        {
          sourceCurrency: 'CNY',
          sourceUnit: '万元',
          multiplier: 10000,
        },
      ],
      summaryTables: [],
      warnings: [],
    };

    const plan = planWorkbookExtraction(workbook, interpretation, 50);

    expect(plan.totalDataRows).toBe(205);
    expect(plan.chunks).toHaveLength(5); // 50 + 50 + 50 + 50 + 5

    // Chunk 1
    expect(plan.chunks[0].inputRowNumbers).toHaveLength(50);
    expect(plan.chunks[0].inputRowNumbers[0]).toBe(2);
    expect(plan.chunks[0].inputRowNumbers[49]).toBe(51);
    expect(plan.chunks[0].headerText).toContain('[Header Row 1] 序号 | 名称 | 金额');
    expect(plan.chunks[0].currencyContext?.multiplier).toBe(10000);

    // Chunk 5 (last chunk)
    expect(plan.chunks[4].inputRowNumbers).toHaveLength(5);
    expect(plan.chunks[4].inputRowNumbers[0]).toBe(202);
    expect(plan.chunks[4].inputRowNumbers[4]).toBe(206);
  });
});
