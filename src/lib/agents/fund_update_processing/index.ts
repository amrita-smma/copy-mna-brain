import { tryDeterministicFundUpdateParse } from '@/lib/fund_updates';
import type { FundUpdateStructuredResult } from '@/lib/fund_updates';
import { logger } from '../logger';

/**
 * Fund-update ingestion agent.
 *
 * Known Excel master sheets (e.g. STARTECH quarterly) are parsed deterministically.
 * Other formats fall through to a placeholder until the LLM/OCR path lands
 * (pending mockup / sample files).
 */
export async function processFundUpdateContent(
  rawText: string,
  buffer: Buffer,
  contentType: string,
  _userRawNotes: string,
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

  // TODO: When the caller forced fund_updates but no fingerprint matched, this
  // returns pending_llm only — no LLM is invoked. Implement real extraction
  // (or fall through to processFileContent) so the Fund Updates override is useful.
  logger.info('⏳ No known Excel template matched; returning placeholder fund-update result');
  const textHint = rawText.trim().slice(0, 200);
  return {
    file_type: 'fund_updates',
    parser: 'pending_llm',
    summary:
      'Fund update document queued for review. Detailed extraction for this format is not wired yet ' +
      '(awaiting mockup / LLM path). Known STARTECH master sheets are parsed automatically.',
    key_points: [
      'No matching deterministic Excel template',
      textHint ? `Text preview: ${textHint}` : 'No extracted text preview available',
    ],
    action_items: [
      // TODO: Replace once LLM fund-update extraction ships.
      'Manual review required — automatic extraction for this format is not implemented yet.',
    ],
    tags: ['Fund Update'],
    companies_detected: [],
    company_notes: [],
    file_date: null,
    suggested_track_ids: [],
    matched_companies: [],
  };
}
