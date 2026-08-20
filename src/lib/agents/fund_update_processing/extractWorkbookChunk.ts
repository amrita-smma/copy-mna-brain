import type { ExtractionChunk } from './planWorkbookExtraction';
import { ChunkExtractionSchema, type ChunkExtractionResult } from './schemas';
import { invokeStructuredOutput, type LLMClientOverride } from './structuredOutput';
import { logger } from '../logger';

export interface ExtractWorkbookChunkOptions {
  chunk: ExtractionChunk;
  llmOverride?: LLMClientOverride;
}

const SYSTEM_PROMPT = `You are an expert financial ledger and fund data extraction assistant.
Your task is to extract structured entities, events, and valuations from the provided slice of rows from a financial spreadsheet.

## Critical Rules:
1. **Account for Every Single Row (MANDATORY)**:
   - For every row number in the input list, you MUST list it in either:
     - \`parsedRows\`: Rows from which you successfully extracted one or more events / valuations / entities.
     - \`excludedRows\`: Header, subtotal, blank, decorative, or irrelevant rows (must give reason).
     - \`ambiguousRows\`: Unclear, corrupted, or contradictory rows that could not be parsed confidently (must give reason).
   - The set \`parsedRows + excludedRows + ambiguousRows\` MUST exactly match all input row numbers.
2. **Extract Entities**:
   - Distinct funds, investors (institutional or individual), holding entities, and portfolio assets / companies.
   - Retain the exact \`originalName\` from the cell. English name / translation should be in \`englishName\` or \`aliases\`.
   - Set \`proposalId\` to a stable identifier (e.g. "ent_1", "ent_2" or derived from slug).
3. **Extract Events**:
   - Financial lifecycle actions:
     - \`capital_contribution\` (实缴 / contribution)
     - \`commitment\` (认缴 / commitment)
     - \`commitment_reduction\` (减资 / reduction)
     - \`investor_distribution\` (分配 / distribution)
     - \`asset_investment\` (投资 / asset investment)
     - \`asset_follow_on_investment\`
     - \`asset_exit\` (退出 / exit)
     - \`asset_exit_distribution\`
     - \`capital_adjustment\` (实缴调整 / adjustment)
     - \`commitment_transfer\` (transfer)
     - \`other\`
   - Set \`fromEntityRef\`: Initiating entity or investor (original name or proposalId).
   - Set \`toEntityRef\`: Target entity, company, or fund (original name or proposalId).
   - Set \`relatedFundRef\`: The fund vehicle name if mentioned.
   - Set \`date\`: YYYY-MM-DD format if present (e.g. "2024-01-15"). If date is invalid or ambiguous, provide raw text in warnings and do NOT guess or drop.
   - Set \`sourceAmount\`: Numeric amount from the document.
   - Set \`sourceCurrency\` & \`sourceUnit\`: e.g. "CNY", "万元" or "USD".
   - Set \`sourceAction\`: The verbatim action name in the document (e.g. "实缴", "认缴", "投资").
   - Set \`sourceLocation\`: \`{ sheet: "<sheetName>", row: <rowNumber> }\`.
4. **Extract Valuations**:
   - If rows contain valuation/market value data at an asOfDate.
5. **No Silent Drops or Fallbacks**:
   - Never convert unknown funds to "Others". Retain the raw fund name.
   - Never invent numbers.`;

export async function extractWorkbookChunk(options: ExtractWorkbookChunkOptions): Promise<ChunkExtractionResult> {
  const { chunk, llmOverride } = options;
  logger.info(`📄 Extracting chunk ${chunk.chunkId} (${chunk.inputRowNumbers.length} rows)`);

  const rowLines: string[] = [];
  for (const r of chunk.rows) {
    rowLines.push(`[Row ${r.rowNumber}] ${r.formattedValues.join(' | ')}`);
  }

  const currencyHint = chunk.currencyContext
    ? `Detected Currency/Unit: ${chunk.currencyContext.sourceCurrency} (${chunk.currencyContext.sourceUnit}, multiplier: ${chunk.currencyContext.multiplier})`
    : 'Detected Currency/Unit: None explicitly specified.';

  const glossaryHint = chunk.glossaryContext.length > 0
    ? `Glossary definitions:\n${chunk.glossaryContext.map((g) => `- ${g.term}: ${g.definition}`).join('\n')}`
    : '';

  const prompt = `Extract structured entities, events, valuations, and complete row accounting for this table chunk:

Sheet: "${chunk.sheetName}" (Table: ${chunk.tableId}, Purpose: ${chunk.tablePurpose})
Chunk: ${chunk.chunkId} (${chunk.chunkIndex + 1} of ${chunk.totalChunks})
Input Row Numbers: [${chunk.inputRowNumbers.join(', ')}]

${currencyHint}

${glossaryHint}

${chunk.headerText ? `Headers:\n${chunk.headerText}\n` : ''}
Data Rows:
${rowLines.join('\n')}

Remember: Account for every input row in parsedRows, excludedRows, or ambiguousRows.`;

  const result = await invokeStructuredOutput<ChunkExtractionResult>({
    schema: ChunkExtractionSchema,
    systemPrompt: SYSTEM_PROMPT,
    prompt,
    toolName: 'record_chunk_extraction',
    llmOverride,
  });

  result.chunkId = chunk.chunkId;
  result.sheetName = chunk.sheetName;
  result.tableId = chunk.tableId;
  result.inputRows = chunk.inputRowNumbers;

  // Stamp sheet on excluded and ambiguous rows if missing
  for (const e of result.excludedRows) {
    if (!e.sheet) e.sheet = chunk.sheetName;
  }
  for (const a of result.ambiguousRows) {
    if (!a.sheet) a.sheet = chunk.sheetName;
  }

  // Stamp sheet on events / valuations sourceLocation if missing
  for (const evt of result.events) {
    if (!evt.sourceLocation?.sheet) {
      evt.sourceLocation = { ...evt.sourceLocation, sheet: chunk.sheetName };
    }
  }
  for (const val of result.valuations) {
    if (!val.sourceLocation?.sheet) {
      val.sourceLocation = { ...val.sourceLocation, sheet: chunk.sheetName };
    }
  }

  return result;
}
