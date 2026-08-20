export type {
  ParsedAsset,
  ParsedTxn,
  ParsedValuation,
  SellProceedsDestination,
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
  startechQuarterlyParser,
} from './parsers/startech_quarterly';
export {
  NANJING_ASSET_CODE_PREFIX,
  NANJING_TEMPLATE_ID,
  fingerprintNanjingFundLedger,
  generateNanjingAssetCode,
  isNanjingAssetCode,
  nanjingFundLedgerParser,
  parseLedgerCommitmentEvents,
} from './parsers/nanjing_fund_ledger';
export type {
  CommitmentEventIntent,
  ParsedCommitmentEvent,
  ParseLedgerCommitmentEventsResult,
} from './parsers/nanjing_fund_ledger';
export type { DeterministicParser, FundUpdateStructuredResult } from './types';
export {
  commitmentEventKey,
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

import { startechQuarterlyParser } from './parsers/startech_quarterly';
import { nanjingFundLedgerParser } from './parsers/nanjing_fund_ledger';
import type { DeterministicParser, FundUpdateStructuredResult } from './types';

function isExcelFile(fileName: string | undefined, contentType: string): boolean {
  const lower = (fileName ?? '').toLowerCase();
  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType === 'application/vnd.ms-excel.sheet.macroenabled.12'
  );
}

const PARSERS: DeterministicParser[] = [
  startechQuarterlyParser,
  nanjingFundLedgerParser,
];

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

  for (const p of PARSERS) {
    const result = await p.parse(buffer);
    if (result) return result;
  }

  return null;
}

