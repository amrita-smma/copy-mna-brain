import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  colNumberToLetter,
  formatWorkbookAsText,
  serializeCell,
  serializeWorkbook,
  serializeWorkbookFromBuffer,
} from './serializeWorkbook';

describe('colNumberToLetter', () => {
  it('converts 1-based columns to Excel letters correctly', () => {
    expect(colNumberToLetter(1)).toBe('A');
    expect(colNumberToLetter(2)).toBe('B');
    expect(colNumberToLetter(26)).toBe('Z');
    expect(colNumberToLetter(27)).toBe('AA');
    expect(colNumberToLetter(28)).toBe('AB');
    expect(colNumberToLetter(52)).toBe('AZ');
    expect(colNumberToLetter(53)).toBe('BA');
  });
});

describe('serializeCell', () => {
  it('handles null / undefined / empty cells', () => {
    const cell = { value: null, address: 'A1' } as ExcelJS.Cell;
    const res = serializeCell(cell, 1, 1);
    expect(res.valueType).toBe('empty');
    expect(res.formattedText).toBe('');
    expect(res.rawValue).toBeNull();
  });

  it('handles strings', () => {
    const cell = { value: '  Hello World  ', address: 'B2' } as ExcelJS.Cell;
    const res = serializeCell(cell, 2, 2);
    expect(res.valueType).toBe('string');
    expect(res.formattedText).toBe('  Hello World  ');
    expect(res.rawValue).toBe('Hello World');
  });

  it('handles numbers and booleans', () => {
    const numCell = { value: 12345.67, address: 'C3' } as ExcelJS.Cell;
    const numRes = serializeCell(numCell, 3, 3);
    expect(numRes.valueType).toBe('number');
    expect(numRes.formattedText).toBe('12345.67');
    expect(numRes.rawValue).toBe(12345.67);

    const boolCell = { value: true, address: 'D4' } as ExcelJS.Cell;
    const boolRes = serializeCell(boolCell, 4, 4);
    expect(boolRes.valueType).toBe('boolean');
    expect(boolRes.formattedText).toBe('TRUE');
  });

  it('handles dates safely', () => {
    const date = new Date('2024-03-15T00:00:00.000Z');
    const cell = { value: date, address: 'E5' } as ExcelJS.Cell;
    const res = serializeCell(cell, 5, 5);
    expect(res.valueType).toBe('date');
    expect(res.formattedText).toBe('2024-03-15');
    expect(res.rawValue).toBe('2024-03-15');
  });

  it('handles rich text runs without [object Object]', () => {
    const cell = {
      value: {
        richText: [
          { text: '高亚投资有限公司\n' },
          { text: 'GLOBE ASIA INVESTMENTS LIMITED', font: { bold: true } },
        ],
      },
      address: 'F6',
    } as unknown as ExcelJS.Cell;

    const res = serializeCell(cell, 6, 6);
    expect(res.valueType).toBe('rich_text');
    expect(res.formattedText).toBe('高亚投资有限公司\nGLOBE ASIA INVESTMENTS LIMITED');
    expect(res.formattedText).not.toContain('[object Object]');
    expect(res.richTextRuns).toHaveLength(2);
    expect(res.richTextRuns?.[0].text).toBe('高亚投资有限公司\n');
  });

  it('handles formulas and cached results separately', () => {
    const formulaCell = {
      value: {
        formula: 'SUM(A1:A10)',
        result: 50000,
      },
      address: 'G7',
    } as unknown as ExcelJS.Cell;

    const res = serializeCell(formulaCell, 7, 7);
    expect(res.valueType).toBe('formula');
    expect(res.formula).toBe('SUM(A1:A10)');
    expect(res.formulaResult).toBe(50000);
    expect(res.formattedText).toBe('50000');
    expect(res.formattedText).not.toContain('[object Object]');
  });

  it('handles formulas with richText or date results', () => {
    const formulaWithRichText = {
      value: {
        formula: 'CONCAT(A1, B1)',
        result: {
          richText: [{ text: 'Part 1 ' }, { text: 'Part 2' }],
        },
      },
      address: 'H8',
    } as unknown as ExcelJS.Cell;

    const res = serializeCell(formulaWithRichText, 8, 8);
    expect(res.valueType).toBe('formula');
    expect(res.formattedText).toBe('Part 1 Part 2');
    expect(res.formattedText).not.toContain('[object Object]');
  });

  it('handles error cells without crashing', () => {
    const cell = {
      value: { error: '#REF!' },
      address: 'I9',
    } as unknown as ExcelJS.Cell;

    const res = serializeCell(cell, 9, 9);
    expect(res.valueType).toBe('error');
    expect(res.formattedText).toBe('#REF!');
  });

  it('handles hyperlinks', () => {
    const cell = {
      value: {
        text: 'Google',
        hyperlink: 'https://google.com',
      },
      address: 'J10',
    } as unknown as ExcelJS.Cell;

    const res = serializeCell(cell, 10, 10);
    expect(res.valueType).toBe('hyperlink');
    expect(res.formattedText).toBe('Google');
    expect(res.hyperlink).toBe('https://google.com');
  });
});

describe('serializeWorkbook and serializeWorkbookFromBuffer', () => {
  it('serializes a multi-sheet workbook and formats text without [object Object]', async () => {
    const wb = new ExcelJS.Workbook();
    const ws1 = wb.addWorksheet('基金流水明细');
    ws1.addRow(['序号', '实体名称', '金额（万元）', '日期']);
    ws1.addRow([
      1,
      {
        richText: [{ text: '高亚投资有限公司\n' }, { text: 'GLOBE ASIA' }],
      },
      15000,
      new Date('2024-01-15T00:00:00.000Z'),
    ]);

    const ws2 = wb.addWorksheet('基金汇总');
    ws2.addRow(['基金名称', '认缴总额']);
    ws2.addRow(['南京高亚一期', 50000]);

    const serialized = serializeWorkbook(wb, 'test.xlsx');
    expect(serialized.sheets).toHaveLength(2);
    expect(serialized.sheets[0].name).toBe('基金流水明细');
    expect(serialized.sheets[0].rows).toHaveLength(2);
    expect(serialized.sheets[0].rows[1].formattedValues[1]).toBe('高亚投资有限公司\nGLOBE ASIA');

    const formattedText = formatWorkbookAsText(serialized);
    expect(formattedText).not.toContain('[object Object]');
    expect(formattedText).toContain('--- Sheet: 基金流水明细');
    expect(formattedText).toContain('高亚投资有限公司');
    expect(formattedText).toContain('15000');
    expect(formattedText).toContain('2024-01-15');

    // Test buffer serialization (round-trip with ExcelJS buffer)
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const fromBuf = await serializeWorkbookFromBuffer(buffer, 'test.xlsm');
    expect(fromBuf.sheets).toHaveLength(2);
    expect(fromBuf.fileName).toBe('test.xlsm');
    const bufText = formatWorkbookAsText(fromBuf);
    expect(bufText).not.toContain('[object Object]');
  });
});
