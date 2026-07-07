import ExcelJS from 'exceljs';

/**
 * Generic multi-sheet Excel workbook builder.
 *
 * Kept intentionally data-agnostic: callers assemble `sheets` (each a set of
 * typed columns + plain row objects keyed by column key) and this module turns
 * them into a styled .xlsx buffer. The join/mapping logic that pulls a company
 * across many tables lives in the tool that consumes this (email_company_excel),
 * so this renderer stays pure and easily unit-testable.
 */

export type ExcelCellValue = string | number | boolean | null | undefined;

export interface ExcelColumn {
  /** Human-readable header shown in the first (frozen) row. */
  header: string;
  /** Key looked up on each row object. */
  key: string;
  /** Column width in characters. Defaults to 22. */
  width?: number;
}

export interface ExcelSheet {
  /** Tab name. Sanitized to satisfy Excel's 31-char / reserved-char rules. */
  name: string;
  columns: ExcelColumn[];
  rows: Array<Record<string, ExcelCellValue>>;
}

export interface CompanyExcelInput {
  /** Workbook title — used for document metadata only. */
  title: string;
  /** ISO timestamp the export was generated (metadata). */
  generatedAt: string;
  /** One or more sheets. Must contain at least one sheet with columns. */
  sheets: ExcelSheet[];
}

const RESERVED_SHEET_CHARS = /[\\/?*[\]:]/g;
const HEADER_FILL = 'FF1F2937'; // slate-800
const HEADER_FONT = 'FFFFFFFF'; // white

/**
 * Excel forbids `\ / ? * [ ] :` in tab names and caps them at 31 chars. Also
 * de-duplicate names within a workbook so two sheets never collide.
 */
function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = (name || 'Sheet')
    .replace(RESERVED_SHEET_CHARS, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Render the given sheets into an .xlsx workbook and return its bytes.
 * Throws if there is no sheet with at least one column.
 */
export async function generateCompanyExcel(
  input: CompanyExcelInput,
): Promise<Buffer> {
  if (!input.sheets || input.sheets.length === 0) {
    throw new Error('generateCompanyExcel: at least one sheet is required');
  }
  const renderable = input.sheets.filter((s) => s.columns.length > 0);
  if (renderable.length === 0) {
    throw new Error('generateCompanyExcel: every sheet must have at least one column');
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MnA Brain 2.0';
  workbook.title = input.title;
  const created = new Date(input.generatedAt);
  if (!Number.isNaN(created.getTime())) {
    workbook.created = created;
  }

  const usedNames = new Set<string>();
  for (const sheet of renderable) {
    const ws = workbook.addWorksheet(sanitizeSheetName(sheet.name, usedNames));
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width ?? 22,
    }));

    // Bold, filled, white header row; frozen so it stays visible while scrolling.
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: HEADER_FONT } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_FILL },
    };
    headerRow.alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of sheet.rows) {
      // Normalize undefined → null so exceljs renders an empty cell.
      const normalized: Record<string, ExcelCellValue> = {};
      for (const col of sheet.columns) {
        const v = row[col.key];
        normalized[col.key] = v === undefined ? null : v;
      }
      ws.addRow(normalized);
    }

    if (sheet.rows.length > 0) {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
      };
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
