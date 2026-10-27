import type { Workbook, Worksheet } from "exceljs";
import {
  fieldForHeader,
  findHeaderRow,
  parseContactTable,
  type ParsedContactFile,
} from "./contactImport";

/**
 * Excel (.xlsx) reader for the CRM contact import. Turns the first worksheet
 * that has data into a string table and hands it to `parseContactTable`, so
 * header matching and validation are identical to the CSV path.
 *
 * `exceljs` is loaded lazily: this runs in the browser, and the library is only
 * worth its weight once someone actually drops a spreadsheet.
 */
export async function parseContactWorkbook(
  data: ArrayBuffer,
): Promise<ParsedContactFile> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook: Workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) {
    return { rows: [], mappedHeaders: {}, extraHeaders: [], errors: ["The workbook is empty."] };
  }
  return parseContactTable(worksheetToTable(sheet));
}

/**
 * Worksheet → rows of display strings, blank rows dropped. A hyperlinked cell
 * under the header row's LinkedIn column yields the link target, since the
 * visible text is often just "Profile"; elsewhere the visible text wins (a
 * name linked to a profile stays a name). The header row is located with
 * `findHeaderRow`, so a banner above it doesn't hide the LinkedIn column.
 */
export function worksheetToTable(sheet: Worksheet): string[][] {
  const table: string[][] = [];
  const links: (string | undefined)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    const rowLinks: (string | undefined)[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const i = colNumber - 1;
      cells[i] = cell.text?.trim() ?? "";
      const value = cell.value as { hyperlink?: unknown } | null;
      if (
        value &&
        typeof value === "object" &&
        typeof value.hyperlink === "string" &&
        /^https?:\/\//i.test(value.hyperlink)
      ) {
        rowLinks[i] = value.hyperlink;
      }
    });
    for (let i = 0; i < cells.length; i++) cells[i] ??= "";
    if (!cells.some((c) => c !== "")) return;
    table.push(cells);
    links.push(rowLinks);
  });
  if (table.length === 0) return table;

  const headerRow = findHeaderRow(table);
  const linkedinCol = table[headerRow].findIndex((h) => fieldForHeader(h) === "linkedinUrl");
  if (linkedinCol >= 0) {
    for (let r = headerRow + 1; r < table.length; r++) {
      const link = links[r][linkedinCol];
      if (link) table[r][linkedinCol] = link;
    }
  }

  const width = Math.max(...table.map((row) => row.length));
  return table.map((row) => {
    const padded = row.slice();
    while (padded.length < width) padded.push("");
    return padded;
  });
}
