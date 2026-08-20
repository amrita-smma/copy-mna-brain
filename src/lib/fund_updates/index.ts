export type {
  ParsedAsset,
  ParsedTxn,
  ParsedValuation,
  StartechParseResult,
  TxnTypeEnum,
  ValuationMethodEnum,
} from './parsers/startech_quarterly';
export {
  FUND_CATALOG,
  OTHERS_FUND,
  STARTECH_TEMPLATE_ID,
  fingerprintStartechQuarterly,
  fundForEntity,
  parseStartechQuarterlyBuffer,
  parseStartechQuarterlyForIngestion,
  parseWorkbook,
  resolveAppendixId,
  scoreAppendixNameMatch,
} from './parsers/startech_quarterly';
export type { FundUpdateStructuredResult } from './types';
export {
  fundUpdateTxnKey,
  fundUpdateValKey,
  sortFundUpdateReviewAssets,
} from './reviewKeys';
export {
  assetCodesForCatalogName,
  hydrateParsedAssetsFromEvents,
} from './linkCatalogAssets';
export type {
  AssetCodesForCatalogNameParams,
  FundUpdateCatalogKind,
} from './linkCatalogAssets';
export type { FundUpdateAssetStatus } from './reviewKeys';

import {
  parseStartechQuarterlyForIngestion,
  STARTECH_TEMPLATE_ID,
} from './parsers/startech_quarterly';
import type { FundUpdateStructuredResult } from './types';

function isExcelFile(fileName: string | undefined, contentType: string): boolean {
  const lower = (fileName ?? '').toLowerCase();
  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType === 'application/vnd.ms-excel.sheet.macroenabled.12'
  );
}

/**
 * Try known deterministic Excel templates. Returns null when no fingerprint matches
 * so callers can fall through to an LLM fund-update agent.
 *
 * TODO: Pair with a dedicated file-type classifier when non-fingerprint fund
 * updates need auto-routing (removed `file_classifier` from this PR as out of scope).
 */
export async function tryDeterministicFundUpdateParse(
  buffer: Buffer,
  contentType: string,
  fileName?: string,
): Promise<FundUpdateStructuredResult | null> {
  if (!isExcelFile(fileName, contentType)) return null;

  const parsed = await parseStartechQuarterlyForIngestion(buffer);
  if (!parsed) return null;

  const { stats, assets, template_id } = parsed;
  const assetNames = assets.map((a) => a.name);
  const funds = [...new Set(assets.map((a) => a.fund))].sort();

  // Prefer the latest Market Value Tracker as-of date across assets, else entry dates.
  let fileDate: string | null = null;
  for (const a of assets) {
    for (const v of a.valuations) {
      if (!fileDate || v.asOfDate > fileDate) fileDate = v.asOfDate;
    }
  }
  if (!fileDate) {
    for (const a of assets) {
      if (a.entryDate && (!fileDate || a.entryDate > fileDate)) fileDate = a.entryDate;
    }
  }

  return {
    file_type: 'fund_updates',
    parser: template_id,
    summary:
      `STARTECH quarterly master sheet: ${stats.asset_count} assets ` +
      `(${stats.direct_count} direct, ${stats.fund_of_funds_count} fund-of-funds), ` +
      `${stats.transaction_count} transactions, ${stats.valuation_count} valuations. ` +
      `Proposed only — pending per-asset review before funds DB updates.`,
    key_points: [
      `Format: ${STARTECH_TEMPLATE_ID}`,
      `Funds touched: ${funds.join(', ') || '(none)'}`,
      `${stats.asset_count} proposed asset updates`,
      `${stats.transaction_count} proposed ledger rows`,
      `${stats.valuation_count} proposed valuation marks`,
    ],
    action_items: [
      'Review proposed asset changes in the Fund Updates review flow (mockup pending).',
    ],
    tags: ['Fund Update', 'STARTECH', ...funds.slice(0, 8)],
    companies_detected: assetNames,
    company_notes: [],
    file_date: fileDate,
    suggested_track_ids: [],
    matched_companies: [],
    fund_update_proposal: {
      template_id,
      stats,
      assets,
    },
  };
}
