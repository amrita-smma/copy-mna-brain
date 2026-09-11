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
  GROUP_CATALOG,
  OTHERS_FUND,
  OTHERS_GROUP,
  STARTECH_TEMPLATE_ID,
  fingerprintStartechQuarterly,
  fundForEntity,
  groupForEntity,
  isCompositeEntity,
  parseStartechQuarterlyBuffer,
  parseStartechQuarterlyForIngestion,
  parseWorkbook,
  resolveAppendixId,
  scoreAppendixNameMatch,
  startechQuarterlyParser,
  UNATTRIBUTED_ENTITY,
} from './parsers/startech_quarterly';
export {
  NANJING_ASSET_CODE_PREFIX,
  NANJING_TEMPLATE_ID,
  extractFirstCounterpartyToken,
  fingerprintNanjingFundLedger,
  generateNanjingAssetCode,
  isNanjingAssetCode,
  isSameBusinessIdentity,
  nanjingFundLedgerParser,
  normalizeCanonicalName,
  normalizeInvestorName,
  parseFundCatalog,
  parseLedgerCommitmentEvents,
  reconcileNanjingFundLedger,
  splitBilingual,
  validateTransferCounterparty,
} from './parsers/nanjing_fund_ledger';
export type {
  CommitmentEventIntent,
  CounterpartyValidationResult,
  FundCatalogItem,
  NanjingFundCatalogItem,
  NanjingParserOptions,
  ParsedCommitmentEvent,
  ParseLedgerCommitmentEventsResult,
  ReconciliationResult,
  ReviewItemCategory,
  ReviewProposalItem,
  TransferPairingMetadata,
  TransferPairingStatus,
} from './parsers/nanjing_fund_ledger';
export type {
  DeterministicParser,
  FundUpdateProposal,
  FundUpdateStructuredResult,
  LegacyAssetProposal,
  FundUpdateCatalogMatch,
  FundUpdateCatalogMatchStatus,
  FundUpdateAssetReview,
  FundUpdateFullReview,
  WizardStep,
  EntityTabKind,
  Step2TabKind,
  EntityStatus,
  EntityLink,
  EntityField,
  ReviewEntity,
  StagedReviewEntityInput,
  ReviewTransactionLeg,
  MultiTransferAllocation,
  NonCashAdjustmentState,
  SingleTransferState,
  ReviewTransaction,
  ReviewBusinessEvent,
  ReviewBusinessEventEdits,
  ReviewValuation,
  ReviewValuationEdits,
  ReviewReconciliation,
  ReviewOption,
  FundUpdateTwoStepReview,
  NormalizedTwoStepReview,
  FundUpdateTwoStepApproval,
  FundUpdateStats,
  FundUpdateReviewData,
  BusinessEventBackingRef,
  ValuationBackingRef,
  SubmittedRowFamily,
  SubmittedRowDisposition,
  SubmittedRowOutcome,
} from './types';
export {
  PERSISTABLE_V1_ASSET_EVENT_TYPES,
  isPersistableV1AssetEventType,
} from './types';
export {
  commitmentEventKey,
  reviewCommitmentEventKey,
  fundUpdateTxnKey,
  fundUpdateValKey,
  buildCommitmentEventDedupKey,
  buildLedgerEntryCommitmentDedupKey,
  buildCommitmentTransferDedupKey,
  buildAdjustmentDedupKey,
  sortFundUpdateReviewAssets,
  defaultCommitmentEventSelection,
  filterCommitmentEventsByInvestor,
  setInvestorCommitmentEventSelection,
} from './reviewKeys';
export {
  assetCodesForCatalogName,
  hydrateParsedAssetsFromEvents,
} from './linkCatalogAssets';
export {
  earliestFundUpdatePositionDate,
  earliestIsoDate,
  isIsoDate,
  normalizeParsedAsset,
  normalizeParsedAssets,
  quarterPeriodLabel,
} from './normalizeParsedAsset';
export {
  buildNormalizedTwoStepReview,
  validateTwoStepDependencies,
} from './twoStepReview';
export {
  classifyFundUpdateTxn,
  computeSignedCashDelta,
  reclassifyReviewTransaction,
  SUPPORTED_CLASSIFICATION_TYPES,
} from './canonicalEvent';
export type {
  CanonicalClassification,
  FundUpdateCanonicalKind,
} from './canonicalEvent';
export type {
  AssetCodesForCatalogNameParams,
  FundUpdateCatalogKind,
} from './linkCatalogAssets';
export type { FundUpdateAssetStatus } from './types';

import { startechQuarterlyParser } from './parsers/startech_quarterly';
import { nanjingFundLedgerParser } from './parsers/nanjing_fund_ledger';
import type { DeterministicParser, FundUpdateStructuredResult, NanjingParserOptions } from './types';

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
  options?: NanjingParserOptions,
): Promise<FundUpdateStructuredResult | null> {
  if (!isExcelFile(fileName, contentType)) return null;

  for (const p of PARSERS) {
    const result = await p.parse(buffer, options);
    if (result) return result;
  }

  return null;
}
