import type { SerializedWorkbook } from '@/lib/workbook/types';
import type { WorkbookInterpretation } from '@/lib/fund_updates/types';
import { WorkbookInterpretationSchema } from './schemas';
import { invokeStructuredOutput, type LLMClientOverride } from './structuredOutput';
import { logger } from '../logger';

export interface InterpretWorkbookOptions {
  workbook: SerializedWorkbook;
  llmOverride?: LLMClientOverride;
}

const SYSTEM_PROMPT = `You are a financial spreadsheet layout and structure analyst.
Your task is to analyze the structural overview and sample rows of an unknown financial workbook (such as a fund reporting pack, capital account ledger, or investment overview) and produce a structured interpretation of its contents.

## Objectives:
1. **Identify Languages**: List all languages found (e.g. "zh", "en", "id", "ja").
2. **Identify Workbook Purpose**: Explain the main purpose of this workbook.
3. **Identify Tables and Sheets**:
   - Classify each table/sheet role:
     - \`event_ledger\`: A transactional or cash-flow ledger (contributions, commitments, investments, distributions).
     - \`entity_master\`: A list of funds, investors, holding entities, or portfolio assets.
     - \`valuation_table\`: Market valuations / NAVs by date.
     - \`summary\`: Summary rollup / aggregates by fund or entity.
     - \`definitions\`: Glossary or field descriptions.
     - \`unknown\`: Non-data or unrecognized format.
   - Identify the exact header rows (1-based), data start row, and data end row.
   - Map columns to their semantic roles (e.g. "entity_name", "target_name", "date", "amount", "action", "fund_name", "currency", "notes").
4. **Identify Currencies and Units (CRITICAL)**:
   - Carefully detect currencies (e.g. CNY, USD, SGD, IDR, JPY) and unit multipliers.
   - Example East Asian units:
     - 万元 (CNY 10,000) -> multiplier: 10000
     - 亿元 (CNY 100,000,000) -> multiplier: 100000000
     - 억 (KRW 100,000,000) -> multiplier: 100000000
     - 万 / 萬 (10,000) -> multiplier: 10000
     - mn (millions) -> multiplier: 1000000
     - bn (billions) -> multiplier: 1000000000
     - k / thousands -> multiplier: 1000
   - Record exact evidence (sheet, cell, or header text) for every currency/unit multiplier.
5. **Extract Document Glossary / Definitions**:
   - If the workbook has definition or explanation sheets/notes, extract all terms and meanings.
6. **Identify Summary Tables for Reconciliation**:
   - If summary rollups exist (e.g. fund-level totals for capital or invested amounts), extract the target metrics and cell addresses so code can reconcile ledger totals against summary figures.

Never guess without evidence. If uncertain, record warnings.`;

/**
 * Builds a compact summary sample of the workbook (metadata + first/middle/last rows)
 * without passing unbounded cell data.
 */
export function buildWorkbookManifest(workbook: SerializedWorkbook): string {
  const parts: string[] = [];
  parts.push(`Workbook File: ${workbook.fileName || 'unknown.xlsx'}`);
  parts.push(`Sheets (${workbook.sheets.length}):`);

  for (const sheet of workbook.sheets) {
    parts.push(`\n--- Sheet: "${sheet.name}" (Total Rows: ${sheet.rowCount}, Non-Empty: ${sheet.nonEmptyRowCount}, Cols: ${sheet.columnCount}) ---`);
    if (sheet.mergedRanges.length > 0) {
      parts.push(`Merged ranges: ${sheet.mergedRanges.slice(0, 10).join(', ')}${sheet.mergedRanges.length > 10 ? '...' : ''}`);
    }

    const nonEmptyRows = sheet.rows.filter((r) => r.hasContent);
    if (nonEmptyRows.length === 0) {
      parts.push('(Sheet is empty)');
      continue;
    }

    // Sample top rows (1-10)
    const topRows = nonEmptyRows.slice(0, 10);
    parts.push('Top rows sample:');
    for (const r of topRows) {
      parts.push(`  [Row ${r.rowNumber}] ${r.formattedValues.filter((v) => v !== '').join(' | ')}`);
    }

    // Sample middle rows if sheet is large
    if (nonEmptyRows.length > 20) {
      const midIdx = Math.floor(nonEmptyRows.length / 2);
      const midRows = nonEmptyRows.slice(midIdx, midIdx + 4);
      parts.push('Middle rows sample:');
      for (const r of midRows) {
        parts.push(`  [Row ${r.rowNumber}] ${r.formattedValues.filter((v) => v !== '').join(' | ')}`);
      }
    }

    // Sample tail rows (last 3)
    if (nonEmptyRows.length > 10) {
      const tailRows = nonEmptyRows.slice(-3);
      parts.push('Tail rows sample:');
      for (const r of tailRows) {
        parts.push(`  [Row ${r.rowNumber}] ${r.formattedValues.filter((v) => v !== '').join(' | ')}`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Interprets workbook layout, tables, currencies, units, and glossary.
 */
export async function interpretWorkbook(options: InterpretWorkbookOptions): Promise<WorkbookInterpretation> {
  const { workbook, llmOverride } = options;
  logger.info(`🔍 Interpreting workbook with ${workbook.sheets.length} sheets`);

  const manifest = buildWorkbookManifest(workbook);

  const prompt = `Analyze this workbook structure and provide a complete WorkbookInterpretation according to the schema:\n\n${manifest}`;

  const interpretation = await invokeStructuredOutput<WorkbookInterpretation>({
    schema: WorkbookInterpretationSchema as any,
    systemPrompt: SYSTEM_PROMPT,
    prompt,
    toolName: 'record_workbook_interpretation',
    llmOverride,
  });

  return interpretation;
}
