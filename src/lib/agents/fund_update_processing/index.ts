import { tryDeterministicFundUpdateParse } from '@/lib/fund_updates';
import type { FundUpdateStructuredResult } from '@/lib/fund_updates';
import { logger } from '../logger';
import { extractFundUpdateProposal } from './llmExtractor';
import { orchestrateWorkbookFallback } from './orchestrateFallback';
import type { ParsedAsset } from '@/lib/fund_updates';

export { orchestrateWorkbookFallback } from './orchestrateFallback';
export { interpretWorkbook } from './interpretWorkbook';
export { planWorkbookExtraction } from './planWorkbookExtraction';
export { extractWorkbookChunk } from './extractWorkbookChunk';
export { mergeWorkbookExtraction } from './mergeWorkbookExtraction';
export { normalizeWorkbookExtraction } from './normalizeWorkbookExtraction';
export { validateWorkbookExtraction } from './validateWorkbookExtraction';

/**
 * Shared helper to build a FundUpdateStructuredResult from LLM extracted assets.
 * Can merge with an existing LLM result (e.g. from general file_processing) 
 * or synthesize a basic summary if none is provided.
 */
export function buildLlmFundUpdateResult(
  assets: ParsedAsset[] | null,
  baseResult?: Partial<FundUpdateStructuredResult> | null,
): FundUpdateStructuredResult {
  const base = baseResult ?? {
    file_type: 'fund_updates',
    summary: 'Extracted via LLM fallback.',
    key_points: [],
    action_items: [],
    tags: ['Fund Update'],
    companies_detected: [],
    company_notes: [],
    file_date: null,
    suggested_track_ids: [],
    matched_companies: [],
  };

  if (!assets || assets.length === 0) {
    return {
      ...base,
      file_type: 'fund_updates',
      parser: 'llm_fallback',
    } as FundUpdateStructuredResult;
  }

  let directCount = 0;
  let fundOfFundsCount = 0;
  let txnCnt = 0;
  let valCnt = 0;
  
  for (const a of assets) {
    if (a.assetType === 'fund_of_funds') {
      fundOfFundsCount++;
    } else {
      directCount++;
    }
    txnCnt += a.txns.length;
    valCnt += a.valuations.length;
  }

  const stats = {
    asset_count: assets.length,
    direct_count: directCount,
    fund_of_funds_count: fundOfFundsCount,
    transaction_count: txnCnt,
    valuation_count: valCnt,
  };

  const funds = [...new Set(assets.map((a) => a.fund).filter(Boolean))].sort();
  const assetNames = assets.map((a) => a.name);

  // Synthesize summary if missing
  const summary = baseResult?.summary || 
    `Extracted ${assets.length} assets (${txnCnt} txns, ${valCnt} valuations) via LLM.`;

  return {
    ...base,
    file_type: 'fund_updates',
    parser: 'llm_fallback',
    summary,
    tags: baseResult?.tags || ['Fund Update', ...funds.slice(0, 8)],
    companies_detected: baseResult?.companies_detected || assetNames,
    fund_update_proposal: {
      template_id: 'llm_generic_v1',
      stats,
      assets,
    }
  } as FundUpdateStructuredResult;
}

/**
 * Fund-update ingestion agent.
 *
 * Known Excel master sheets (e.g. STARTECH quarterly) are parsed deterministically.
 * Other formats fall through to the dedicated LLM fund update extractor.
 */
export async function processFundUpdateContent(
  rawText: string,
  buffer: Buffer,
  contentType: string,
  fileName?: string,
): Promise<FundUpdateStructuredResult> {
  logger.info('📂 Processing Fund Update file');

  const deterministic = await tryDeterministicFundUpdateParse(buffer, contentType, fileName);
  if (deterministic) {
    logger.info(
      `✅ Deterministic fund-update parse (${deterministic.parser}): ` +
        `${deterministic.fund_update_proposal?.stats.asset_count ?? 0} assets`,
    );
    return deterministic;
  }

  logger.info('⏳ No known Excel template matched; falling back to fund update LLM extractor');

  const isExcel =
    Boolean(fileName?.toLowerCase().endsWith('.xlsx')) ||
    Boolean(fileName?.toLowerCase().endsWith('.xlsm')) ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType === 'application/vnd.ms-excel.sheet.macroenabled.12';
  if (isExcel && buffer && buffer.length > 0) {
    try {
      return await orchestrateWorkbookFallback({
        buffer,
        fileName,
        contentType,
      });
    } catch (err) {
      logger.warn(`Multi-step fallback failed; falling back to legacy single-pass: ${err}`);
    }
  }
  
  const proposalResult = await extractFundUpdateProposal(
    rawText,
    buffer,
    contentType,
    fileName,
  );

  return buildLlmFundUpdateResult(proposalResult?.assets ?? null);
}

