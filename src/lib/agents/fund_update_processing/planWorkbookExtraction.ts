import type { SerializedRow, SerializedSheet, SerializedWorkbook } from '@/lib/workbook/types';
import {
  formatSourceRowKey,
  type CurrencyInterpretation,
  type InterpretedTable,
  type SourceRowRef,
  type WorkbookInterpretation,
} from '@/lib/fund_updates/types';

export interface ExtractionChunk {
  chunkId: string;
  sheetName: string;
  tableId: string;
  tablePurpose: string;
  headerRows: number[];
  headerText: string;
  currencyContext?: CurrencyInterpretation;
  glossaryContext: Array<{ term: string; definition: string }>;
  inputRowNumbers: number[];
  plannedRows: SourceRowRef[];
  rows: SerializedRow[];
  totalTableRows: number;
  chunkIndex: number;
  totalChunks: number;
}

export interface ExtractionPlan {
  totalDataRows: number;
  plannedRows: SourceRowRef[];
  tablesToExtract: InterpretedTable[];
  chunks: ExtractionChunk[];
}

export const DEFAULT_CHUNK_SIZE = 35;

/**
 * Plans chunked extraction for all data tables identified in the workbook interpretation.
 */
export function planWorkbookExtraction(
  workbook: SerializedWorkbook,
  interpretation: WorkbookInterpretation,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): ExtractionPlan {
  const sheetByName = new Map<string, SerializedSheet>();
  for (const sheet of workbook.sheets) {
    sheetByName.set(sheet.name.toLowerCase().trim(), sheet);
  }

  // Filter tables for extraction: event_ledger, entity_master, valuation_table
  let candidateTables = interpretation.tables.filter((t) =>
    ['event_ledger', 'valuation_table', 'entity_master'].includes(t.purpose),
  );

  // If no tables matched specific roles, extract any sheet that has non-empty rows and isn't purely definitions/summary
  if (candidateTables.length === 0) {
    candidateTables = workbook.sheets
      .filter((s) => s.nonEmptyRowCount > 0)
      .map((s, idx) => ({
        tableId: `table_${idx + 1}`,
        sheetName: s.name,
        purpose: 'event_ledger' as const,
        headerRows: [1],
        dataStartRow: 2,
        dataEndRow: s.rows[s.rows.length - 1]?.rowNumber ?? s.rowCount,
        columns: [],
        confidence: 0.8,
      }));
  }

  const allChunks: ExtractionChunk[] = [];
  const allPlannedRows: SourceRowRef[] = [];
  let totalDataRows = 0;

  for (const table of candidateTables) {
    const sheet = sheetByName.get(table.sheetName.toLowerCase().trim());
    if (!sheet) continue;

    // Find header lines
    const headerRows = table.headerRows.length > 0 ? table.headerRows : [1];
    const headerLines: string[] = [];
    for (const hRow of headerRows) {
      const row = sheet.rows.find((r) => r.rowNumber === hRow);
      if (row) {
        headerLines.push(`[Header Row ${hRow}] ${row.formattedValues.join(' | ')}`);
      }
    }
    const headerText = headerLines.join('\n');

    // Find data rows
    const dataStart = table.dataStartRow ?? Math.max(...headerRows) + 1;
    const dataEnd = table.dataEndRow ?? (sheet.rows[sheet.rows.length - 1]?.rowNumber || sheet.rowCount);

    const eligibleRows = sheet.rows.filter(
      (r) => r.rowNumber >= dataStart && r.rowNumber <= dataEnd && r.hasContent,
    );

    if (eligibleRows.length === 0) continue;
    totalDataRows += eligibleRows.length;

    // Find currency/unit for this sheet if any
    const currCtx = interpretation.currencies.find(
      (c) => c.evidence?.sheet?.toLowerCase() === sheet.name.toLowerCase(),
    ) || interpretation.currencies[0];

    // Relevant glossary
    const glossaryCtx = interpretation.glossary.slice(0, 20);

    // Split into chunks of chunkSize
    const chunkCount = Math.ceil(eligibleRows.length / chunkSize);

    for (let cIdx = 0; cIdx < chunkCount; cIdx++) {
      const startIdx = cIdx * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, eligibleRows.length);
      const chunkRows = eligibleRows.slice(startIdx, endIdx);
      const inputRowNumbers = chunkRows.map((r) => r.rowNumber);
      const chunkPlannedRows: SourceRowRef[] = chunkRows.map((r) => ({
        sheet: sheet.name,
        tableId: table.tableId,
        row: r.rowNumber,
        rowKey: formatSourceRowKey(sheet.name, r.rowNumber, table.tableId),
      }));
      allPlannedRows.push(...chunkPlannedRows);

      const chunkId = `${table.tableId}_chunk_${cIdx + 1}_of_${chunkCount}`;

      allChunks.push({
        chunkId,
        sheetName: sheet.name,
        tableId: table.tableId,
        tablePurpose: table.purpose,
        headerRows,
        headerText,
        currencyContext: currCtx,
        glossaryContext: glossaryCtx,
        inputRowNumbers,
        plannedRows: chunkPlannedRows,
        rows: chunkRows,
        totalTableRows: eligibleRows.length,
        chunkIndex: cIdx,
        totalChunks: chunkCount,
      });
    }
  }

  return {
    totalDataRows,
    plannedRows: allPlannedRows,
    tablesToExtract: candidateTables,
    chunks: allChunks,
  };
}
