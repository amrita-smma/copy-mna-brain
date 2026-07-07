import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { generateCompanyExcel, type ExcelSheet } from './companyExcel';

const SHEET: ExcelSheet = {
  name: 'Companies',
  columns: [
    { header: 'Target', key: 'target' },
    { header: 'Revenue', key: 'revenue' },
  ],
  rows: [
    { target: 'Acme', revenue: 112 },
    { target: 'Beta', revenue: null },
  ],
};

async function readBack(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('generateCompanyExcel', () => {
  it('throws when there are no sheets', async () => {
    await expect(
      generateCompanyExcel({ title: 't', generatedAt: '2026-07-07', sheets: [] }),
    ).rejects.toThrow('at least one sheet');
  });

  it('throws when no sheet has any columns', async () => {
    await expect(
      generateCompanyExcel({
        title: 't',
        generatedAt: '2026-07-07',
        sheets: [{ name: 'Empty', columns: [], rows: [] }],
      }),
    ).rejects.toThrow('at least one column');
  });

  it('renders a header row and one row per data row', async () => {
    const buffer = await generateCompanyExcel({
      title: 'Export',
      generatedAt: '2026-07-07T00:00:00.000Z',
      sheets: [SHEET],
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);

    const wb = await readBack(buffer);
    const ws = wb.getWorksheet('Companies');
    expect(ws).toBeDefined();
    expect(ws!.getRow(1).getCell(1).value).toBe('Target');
    expect(ws!.getRow(1).getCell(2).value).toBe('Revenue');
    // Header + 2 data rows.
    expect(ws!.rowCount).toBe(3);
    expect(ws!.getRow(2).getCell(1).value).toBe('Acme');
    expect(ws!.getRow(2).getCell(2).value).toBe(112);
  });

  it('sanitizes reserved characters and truncates long / duplicate sheet names', async () => {
    const buffer = await generateCompanyExcel({
      title: 't',
      generatedAt: '2026-07-07',
      sheets: [
        { name: 'Bad/Name:[1]', columns: [{ header: 'A', key: 'a' }], rows: [] },
        { name: 'Bad/Name:[1]', columns: [{ header: 'A', key: 'a' }], rows: [] },
      ],
    });
    const wb = await readBack(buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toHaveLength(2);
    // No reserved characters survive, and names are unique.
    for (const n of names) {
      expect(n).not.toMatch(/[\\/?*[\]:]/);
      expect(n.length).toBeLessThanOrEqual(31);
    }
    expect(new Set(names).size).toBe(2);
  });

  it('skips sheets that have columns-less definitions but keeps valid ones', async () => {
    const buffer = await generateCompanyExcel({
      title: 't',
      generatedAt: '2026-07-07',
      sheets: [
        { name: 'Empty', columns: [], rows: [] },
        SHEET,
      ],
    });
    const wb = await readBack(buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Companies']);
  });
});
