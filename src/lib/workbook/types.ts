export type SerializedCellType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'rich_text'
  | 'formula'
  | 'hyperlink'
  | 'error'
  | 'empty'
  | 'unknown';

export interface SerializedRichTextRun {
  text: string;
  font?: Record<string, unknown>;
}

export interface SerializedCell {
  address: string;
  row: number;
  col: number;
  colLetter: string;
  valueType: SerializedCellType;
  formattedText: string;
  rawValue: unknown;
  formula?: string;
  formulaResult?: unknown;
  richTextRuns?: SerializedRichTextRun[];
  hyperlink?: string;
  isMerged?: boolean;
  masterAddress?: string;
}

export interface SerializedRow {
  rowNumber: number;
  cells: Record<string, SerializedCell>;
  rawValues: unknown[];
  formattedValues: string[];
  hasContent: boolean;
}

export interface SerializedSheet {
  name: string;
  id: number;
  rowCount: number;
  columnCount: number;
  nonEmptyRowCount: number;
  mergedRanges: string[];
  rows: SerializedRow[];
}

export interface SerializedWorkbook {
  fileName?: string;
  sheets: SerializedSheet[];
}
