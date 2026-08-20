import ExcelJS from 'exceljs';
import type {
  SerializedCell,
  SerializedCellType,
  SerializedRichTextRun,
  SerializedRow,
  SerializedSheet,
  SerializedWorkbook,
} from './types';

/**
 * Converts a 1-based column number to Excel column letter (1 -> A, 27 -> AA, etc.)
 */
export function colNumberToLetter(colNumber: number): string {
  let temp = colNumber;
  let letter = '';
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter || 'A';
}

/**
 * Unwraps an ExcelJS cell value safely into a SerializedCell without ever producing "[object Object]".
 */
export function serializeCell(cell: ExcelJS.Cell, rowNumber: number, colNumber: number): SerializedCell {
  const colLetter = colNumberToLetter(colNumber);
  const address = cell.address || `${colLetter}${rowNumber}`;
  const rawVal = cell.value as unknown;

  const isMerged = Boolean((cell as any).isMerged);
  const masterAddress = (cell as any).master?.address ? String((cell as any).master.address) : undefined;

  if (rawVal == null) {
    return {
      address,
      row: rowNumber,
      col: colNumber,
      colLetter,
      valueType: 'empty',
      formattedText: '',
      rawValue: null,
      isMerged,
      masterAddress,
    };
  }

  if (typeof rawVal === 'boolean') {
    return {
      address,
      row: rowNumber,
      col: colNumber,
      colLetter,
      valueType: 'boolean',
      formattedText: rawVal ? 'TRUE' : 'FALSE',
      rawValue: rawVal,
      isMerged,
      masterAddress,
    };
  }

  if (typeof rawVal === 'number') {
    return {
      address,
      row: rowNumber,
      col: colNumber,
      colLetter,
      valueType: 'number',
      formattedText: Number.isFinite(rawVal) ? String(rawVal) : '',
      rawValue: rawVal,
      isMerged,
      masterAddress,
    };
  }

  if (typeof rawVal === 'string') {
    const trimmed = rawVal.trim();
    return {
      address,
      row: rowNumber,
      col: colNumber,
      colLetter,
      valueType: 'string',
      formattedText: rawVal,
      rawValue: trimmed,
      isMerged,
      masterAddress,
    };
  }

  if (rawVal instanceof Date) {
    const isDateValid = !Number.isNaN(rawVal.getTime());
    const iso = isDateValid ? rawVal.toISOString().slice(0, 10) : '';
    return {
      address,
      row: rowNumber,
      col: colNumber,
      colLetter,
      valueType: 'date',
      formattedText: iso,
      rawValue: isDateValid ? iso : null,
      isMerged,
      masterAddress,
    };
  }

  if (typeof rawVal === 'object') {
    const obj = rawVal as Record<string, unknown>;

    // Error cell: { error: '#REF!' }
    if ('error' in obj) {
      const errStr = String(obj.error ?? '#ERROR');
      return {
        address,
        row: rowNumber,
        col: colNumber,
        colLetter,
        valueType: 'error',
        formattedText: errStr,
        rawValue: errStr,
        isMerged,
        masterAddress,
      };
    }

    // Rich text: { richText: [{ text: 'foo' }, { text: 'bar' }] }
    if ('richText' in obj && Array.isArray(obj.richText)) {
      const runs: SerializedRichTextRun[] = (obj.richText as Array<Record<string, unknown>>).map((r) => ({
        text: r.text != null ? String(r.text) : '',
        font: r.font && typeof r.font === 'object' ? (r.font as Record<string, unknown>) : undefined,
      }));
      const joined = runs.map((r) => r.text).join('');
      return {
        address,
        row: rowNumber,
        col: colNumber,
        colLetter,
        valueType: 'rich_text',
        formattedText: joined,
        rawValue: joined.trim(),
        richTextRuns: runs,
        isMerged,
        masterAddress,
      };
    }

    // Formula cell: { formula: 'SUM(A1:A10)', result: 100 } or { sharedFormula: '...', result: '...' }
    if ('formula' in obj || 'sharedFormula' in obj) {
      const formulaStr = String(obj.formula || obj.sharedFormula || '');
      const resultVal = obj.result;
      let resultText = '';
      let scalarResult: unknown = null;

      if (resultVal == null) {
        resultText = '';
        scalarResult = null;
      } else if (resultVal instanceof Date) {
        resultText = !Number.isNaN(resultVal.getTime()) ? resultVal.toISOString().slice(0, 10) : '';
        scalarResult = resultText;
      } else if (typeof resultVal === 'object') {
        const nestedObj = resultVal as Record<string, unknown>;
        if ('error' in nestedObj) {
          resultText = String(nestedObj.error ?? '#ERROR');
          scalarResult = resultText;
        } else if ('richText' in nestedObj && Array.isArray(nestedObj.richText)) {
          resultText = (nestedObj.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
          scalarResult = resultText;
        } else {
          resultText = '';
          scalarResult = null;
        }
      } else {
        resultText = String(resultVal);
        scalarResult = resultVal;
      }

      return {
        address,
        row: rowNumber,
        col: colNumber,
        colLetter,
        valueType: 'formula',
        formula: formulaStr,
        formulaResult: scalarResult,
        formattedText: resultText,
        rawValue: scalarResult,
        isMerged,
        masterAddress,
      };
    }

    // Hyperlink cell: { text: 'click here', hyperlink: 'https://...' }
    if ('hyperlink' in obj || 'text' in obj) {
      const textVal = obj.text != null ? String(obj.text) : (obj.hyperlink != null ? String(obj.hyperlink) : '');
      const linkVal = obj.hyperlink != null ? String(obj.hyperlink) : undefined;
      return {
        address,
        row: rowNumber,
        col: colNumber,
        colLetter,
        valueType: 'hyperlink',
        formattedText: textVal,
        rawValue: textVal,
        hyperlink: linkVal,
        isMerged,
        masterAddress,
      };
    }
  }

  // Fallback
  const fallbackStr = String(rawVal);
  const safeStr = fallbackStr === '[object Object]' ? '' : fallbackStr;
  return {
    address,
    row: rowNumber,
    col: colNumber,
    colLetter,
    valueType: 'unknown',
    formattedText: safeStr,
    rawValue: safeStr || null,
    isMerged,
    masterAddress,
  };
}

/**
 * Serializes an entire ExcelJS Workbook into a SerializedWorkbook.
 */
export function serializeWorkbook(workbook: ExcelJS.Workbook, fileName?: string): SerializedWorkbook {
  const sheets: SerializedSheet[] = [];

  workbook.eachSheet((worksheet, sheetId) => {
    const sheetName = worksheet.name;
    const mergedRanges: string[] = [];

    // Extract merged ranges if available
    try {
      if ((worksheet as any)._merges) {
        const merges = (worksheet as any)._merges;
        if (typeof merges === 'object') {
          for (const key of Object.keys(merges)) {
            const range = merges[key];
            if (range?.model) {
              mergedRanges.push(String(range.model));
            } else if (typeof range === 'string') {
              mergedRanges.push(range);
            }
          }
        }
      }
    } catch {
      // Ignore merges reflection errors
    }

    const rows: SerializedRow[] = [];
    let maxColCount = 0;
    let nonEmptyRowCount = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: Record<string, SerializedCell> = {};
      const rawValues: unknown[] = [];
      const formattedValues: string[] = [];
      let rowHasContent = false;

      const cellCount = Math.max(row.cellCount, Array.isArray(row.values) ? row.values.length - 1 : 0);
      maxColCount = Math.max(maxColCount, cellCount);

      // Iterate through columns 1 to cellCount
      for (let colNumber = 1; colNumber <= cellCount; colNumber++) {
        const cell = row.getCell(colNumber);
        const serialized = serializeCell(cell, rowNumber, colNumber);
        cells[serialized.colLetter] = serialized;
        rawValues.push(serialized.rawValue);
        formattedValues.push(serialized.formattedText);

        if (serialized.formattedText.trim() !== '') {
          rowHasContent = true;
        }
      }

      if (rowHasContent) {
        nonEmptyRowCount++;
      }

      rows.push({
        rowNumber,
        cells,
        rawValues,
        formattedValues,
        hasContent: rowHasContent,
      });
    });

    sheets.push({
      name: sheetName,
      id: typeof sheetId === 'number' ? sheetId : Number(sheetId) || sheets.length + 1,
      rowCount: rows.length,
      columnCount: maxColCount,
      nonEmptyRowCount,
      mergedRanges,
      rows,
    });
  });

  return {
    fileName,
    sheets,
  };
}

/**
 * Loads a buffer (XLSX or XLSM) and serializes it into a SerializedWorkbook.
 */
export async function serializeWorkbookFromBuffer(buffer: Buffer, fileName?: string): Promise<SerializedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return serializeWorkbook(workbook, fileName);
}

/**
 * Formats a SerializedWorkbook as clean, lossless text representation for LLM ingestion / plain text extraction.
 */
export function formatWorkbookAsText(wb: SerializedWorkbook): string {
  let text = '';
  for (const sheet of wb.sheets) {
    text += `\n--- Sheet: ${sheet.name} (Rows: ${sheet.nonEmptyRowCount}, Cols: ${sheet.columnCount}) ---\n`;
    for (const row of sheet.rows) {
      if (!row.hasContent) continue;
      // Format as comma-separated or row-tagged string
      const line = row.formattedValues
        .map((v) => {
          if (v.includes(',') || v.includes('\n') || v.includes('"')) {
            return `"${v.replace(/"/g, '""')}"`;
          }
          return v;
        })
        .join(', ');
      if (line.trim()) {
        text += `[Row ${row.rowNumber}] ${line}\n`;
      }
    }
  }
  return text;
}
