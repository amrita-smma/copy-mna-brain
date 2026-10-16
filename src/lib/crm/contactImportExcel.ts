import type { Workbook, Worksheet } from "exceljs";
import { fieldForHeader, parseContactTable, type ParsedContactFile } from "./contactImport";

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
 * Worksheet → rows of display strings, starting at the first non-empty row
 * (the header). A hyperlinked cell under a LinkedIn column yields the link
 * target, since the visible text is often just "Profile"; elsewhere the
 * visible text wins (a name linked to a profile stays a name).
 */
export function worksheetToTable(sheet: Worksheet): string[][] {
  const table: string[][] = [];
  let linkedinCol = -1;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const i = colNumber - 1;
      let text = cell.text?.trim() ?? "";
      const value = cell.value as { hyperlink?: unknown } | null;
      if (
        table.length > 0 &&
        i === linkedinCol &&
        value &&
        typeof value === "object" &&
        typeof value.hyperlink === "string" &&
        /^https?:\/\//i.test(value.hyperlink)
      ) {
        text = value.hyperlink;
      }
      cells[i] = text;
    });
    for (let i = 0; i < cells.length; i++) cells[i] ??= "";
    if (!cells.some((c) => c !== "")) return;
    if (table.length === 0) {
      linkedinCol = cells.findIndex((h) => fieldForHeader(h) === "linkedinUrl");
    }
    table.push(cells);
  });
  if (table.length === 0) return table;
  const width = table[0].length;
  return table.map((row) => {
    const padded = row.slice(0, width);
    while (padded.length < width) padded.push("");
    return padded;
  });
}
