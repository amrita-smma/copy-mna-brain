import type { ParsedAsset, ParsedTxn, ParsedValuation, StartechParseResult } from './parsers/startech_quarterly';
export type { ParsedAsset, ParsedTxn, ParsedValuation, StartechParseResult };
import type { CommitmentEventIntent, ParsedCommitmentEvent } from './parsers/nanjing_fund_ledger';
export type { CommitmentEventIntent, ParsedCommitmentEvent };
import type { SellProceedsDestination } from '@/lib/sellProceedsDestination';

export interface SourceLocation {
  sheet: string;
  row: number;
  columns?: string[];
  cellAddress?: string;
}

export function formatSourceRowKey(sheet: string, row: number, tableId?: string): string {
  return `${sheet.trim()}::${(tableId || '').trim()}::${row}`;
}

export type ProposedEntityType =
  | 'fund'
  | 'investor'
  | 'institutional_investor'
  | 'individual_investor'
  | 'investment_vehicle'
  | 'portfolio_company'
  | 'fund_or_partnership_asset'
  | 'counterparty'
  | 'unknown';

export interface ProposedEntity {
  proposalId: string;
  entityType: ProposedEntityType;
  originalName: string;
  englishName?: string | null;
  aliases: string[];
  existingRecordId?: string | null;
  matchConfidence?: number | null;
  sourceLocations: SourceLocation[];
  warnings: string[];
}

export type ProposedEventType =
  | 'commitment'
  | 'commitment_transfer'
  | 'capital_contribution'
  | 'commitment_reduction'
  | 'investor_distribution'
  | 'asset_investment'
  | 'asset_follow_on_investment'
  | 'asset_exit'
  | 'asset_exit_distribution'
  | 'capital_adjustment'
  | 'other';

export const PERSISTABLE_V1_ASSET_EVENT_TYPES = new Set<ProposedEventType>([
  'asset_investment',
  'asset_follow_on_investment',
  'asset_exit',
  'asset_exit_distribution',
]);

export function isPersistableV1AssetEventType(type: ProposedEventType | string): boolean {
  return PERSISTABLE_V1_ASSET_EVENT_TYPES.has(type as ProposedEventType);
}

export interface ProposedEvent {
  proposalId: string;
  eventType: ProposedEventType;
  fromEntityRef?: string | null;
  toEntityRef?: string | null;
  relatedFundRef?: string | null;
  date?: string | null;
  sourceAmount?: number | null;
  sourceCurrency?: string | null;
  sourceUnit?: string | null;
  amountMultiplier?: number | null;
  normalizedAmount?: number | null;
  normalizedCurrency?: string | null;
  sourceAction?: string | null;
  sourceNature?: string | null;
  cashFlowDirection?: 'into_fund' | 'out_of_fund' | 'non_cash' | 'unknown' | null;
  counterpartyRef?: string | null;
  sourceLocation: SourceLocation;
  confidence?: number;
  warnings: string[];
}

export interface ProposedValuation {
  proposalId: string;
  entityRef: string;
  asOfDate: string | null;
  sourceMarketValue: number | null;
  normalizedMarketValue: number | null;
  sourceCurrency: string | null;
  normalizedCurrency: string | null;
  pricePerShare?: number | null;
  sharesOutstanding?: number | null;
  shareholdingPct?: number | null;
  investedCapitalCum?: number | null;
  grossMoic?: number | null;
  grossXirr?: number | null;
  valuationMethod?: string | null;
  sourceLocation: SourceLocation;
  notes?: string | null;
  warnings: string[];
}

export interface SourceRowRef {
  sheet: string;
  tableId?: string;
  row: number;
  rowKey?: string;
}

export interface ExcludedRowItem {
  sheet?: string;
  tableId?: string;
  row: number;
  reason: string;
}

export interface AmbiguousRowItem {
  sheet?: string;
  tableId?: string;
  row: number;
  reason: string;
}

export interface UnaccountedRowItem {
  sheet?: string;
  tableId?: string;
  row: number;
  reason?: string;
}

export interface RowAccounting {
  totalDataRows: number;
  plannedRows?: SourceRowRef[];
  parsedRows: number[];
  parsedRowItems?: SourceRowRef[];
  excludedRows: ExcludedRowItem[];
  ambiguousRows: AmbiguousRowItem[];
  coveragePct: number;
  unaccountedRows: number[];
  unaccountedRowItems?: UnaccountedRowItem[];
}

export interface FundCatalogItem {
  nameZh: string;
  nameEn?: string | null;
  filingCode: string | null;
  subscribedAmount: number | null;
  paidInAmount: number | null;
  investedAmount: number | null;
  /**
   * The summary's own net cash flow (基金净现金流 = 实缴 + 退出 − 投资 − 分配), in CNY.
   * Absent on proposals parsed before the post-import catalog check existed.
   */
  netCashFlowAmount?: number | null;
}

export type NanjingFundCatalogItem = FundCatalogItem;

export type TransferPairingStatus =
  | 'paired'
  | 'reciprocal_reduction_found'
  | 'unknown_counterparty'
  | 'missing_counterparty'
  | 'ambiguous';

export interface TransferPairingMetadata {
  status: TransferPairingStatus;
  transferorName?: string | null;
  counterpartyRaw?: string | null;
  matchedReductionSourceRow?: number | null;
  eligibleForTransferOut: boolean;
  requiresReview: boolean;
  reviewReason?: string | null;
}

export type ReviewItemCategory =
  | 'non_cash_adjustment'
  | 'truncated_transfer'
  | 'multi_party_transfer'
  | 'missing_counterparty'
  | 'other';

export interface ReviewProposalItem {
  sourceRow: number;
  fund: string;
  fundEnglishName?: string | null;
  investorName: string | null;
  investorEnglishName?: string | null;
  investorTypeRaw?: string | null;
  date: string | null;
  amount: number | null;
  currency: 'CNY';
  action: string;
  nature: string | null;
  direction: string | null;
  explanation: string;
  isPostable: false;
  requiresReview: true;
  category?: ReviewItemCategory;
  counterpartyRaw?: string | null;
  targetRaw?: string | null;
  entityRaw?: string | null;
  transferPairing?: TransferPairingMetadata;
}

export interface NanjingParserOptions {
  knownMasterInvestors?: string[];
}

export interface ReconciliationResult {
  metricName: string;
  fund?: string | null;
  targetEventType?: string;
  sourceValue: number;
  calculatedValue: number;
  diff: number;
  diffPct: number;
  currency?: string | null;
  unit?: string | null;
  isReconciled: boolean;
  sheet?: string;
  notes?: string;
}

export interface ValidationStats {
  totalRows: number;
  parsedRowsCount: number;
  excludedRowsCount: number;
  ambiguousRowsCount: number;
  coveragePct: number;
  actionCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  fundTotals: Record<string, { count: number; totalAmount: number; currency: string }>;
}

export interface ValidationResult {
  isReviewable: boolean;
  hardFailures: string[];
  warnings: string[];
  stats: ValidationStats;
}

export interface InterpretedColumn {
  column: string;
  sourceHeader: string;
  semanticRole: string;
  required: boolean;
}

export interface InterpretedTable {
  tableId: string;
  sheetName: string;
  purpose: 'event_ledger' | 'entity_master' | 'valuation_table' | 'summary' | 'definitions' | 'unknown';
  headerRows: number[];
  dataStartRow: number | null;
  dataEndRow: number | null;
  columns: InterpretedColumn[];
  confidence: number;
}

export interface CurrencyInterpretation {
  sourceCurrency: string;
  sourceUnit: string;
  multiplier: number;
  evidence?: {
    sheet?: string;
    cell?: string;
    text?: string;
  };
}

export interface SummaryTableInterpretation {
  sheetName: string;
  tableId: string;
  description?: string;
  purpose?: string;
  metrics: Array<{
    name: string;
    targetFund?: string;
    targetEventType?: string;
    expectedTotal?: number;
    currency?: string;
    unit?: string;
    multiplier?: number;
    cellAddress?: string;
  }>;
}

export interface WorkbookInterpretation {
  detectedLanguages: string[];
  workbookPurpose: string;
  tables: InterpretedTable[];
  glossary: Array<{ term: string; definition: string; category?: string }>;
  currencies: CurrencyInterpretation[];
  summaryTables: SummaryTableInterpretation[];
  warnings: string[];
}

export interface WorkbookFallbackProposalV1 {
  template_id: 'workbook_fallback_v1';
  schema_version: 'workbook_fallback_v1';
  stats: {
    asset_count: number;
    direct_count: number;
    fund_of_funds_count: number;
    transaction_count: number;
    valuation_count: number;
    total_data_rows: number;
    parsed_rows_count: number;
    excluded_rows_count: number;
    ambiguous_rows_count: number;
    coverage_pct: number;
    entity_count: number;
    event_count: number;
  };
  entities: ProposedEntity[];
  events: ProposedEvent[];
  valuations: ProposedValuation[];
  row_accounting: RowAccounting;
  interpretation: WorkbookInterpretation;
  warnings: string[];
  reconciliation: ReconciliationResult[];
  validation: ValidationResult;
  /** Projected legacy assets for backward compatibility with asset-only consumers */
  assets: ParsedAsset[];
  fund_catalog?: string[];
}

export interface LegacyAssetProposal {
  template_id: string;
  stats: StartechParseResult['stats'] & {
    commitment_event_count?: number;
    review_item_count?: number;
  };
  assets: ParsedAsset[];
  fund_catalog?: string[];
  fund_catalog_items?: FundCatalogItem[];
  /** Investor/fund lifecycle rows (commitments, paid-in capital, distributions, transfers). */
  commitment_events?: ParsedCommitmentEvent[];
  /** Structured review-required items (e.g. non-cash adjustments, write-offs). */
  review_items?: ReviewProposalItem[];
  /** Advisory per-fund reconciliation results against summary sheet. */
  reconciliation?: ReconciliationResult[];
}

export interface DeterministicParser {
  templateId: string;
  parse(buffer: Buffer, options?: NanjingParserOptions): Promise<FundUpdateStructuredResult | null>;
}

export type FundUpdateProposal = LegacyAssetProposal | WorkbookFallbackProposalV1;

/**
 * Structured notes shape for `file_type = fund_updates`.
 * Propose-only: reviewers will approve per-asset/event applies later.
 */
export interface FundUpdateStructuredResult {
  file_type: 'fund_updates';
  /** Which parser produced the proposal (e.g. deterministic template_id or llm_fallback). */
  parser: string;
  summary: string;
  key_points: string[];
  action_items: string[];
  tags: string[];
  companies_detected: string[];
  company_notes: Array<{ company_name: string; note: string }>;
  file_date: string | null;
  suggested_track_ids: string[];
  matched_companies: unknown[];
  /** Deterministic / LLM proposal payload for HITL. Absent if no assets were found. */
  fund_update_proposal?: FundUpdateProposal;
}

// -------------------------------------------------------------
// MB-513 Shared Review Contract Types
// -------------------------------------------------------------

export type FundUpdateCatalogKind = 'asset' | 'fund' | 'investor' | 'source';

export type FundUpdateCatalogMatchStatus = 'new' | 'existing';

export interface FundUpdateCatalogMatch {
  name: string;
  english_name?: string | null;
  status: FundUpdateCatalogMatchStatus;
  matched_id: string | null;
  asset_codes?: string[];
  auto_created?: boolean;
  role?: string | null;
}

export type FundUpdateAssetStatus = 'new' | 'unchanged' | 'add_missing';

export interface FundUpdateAssetReview {
  code: string;
  name: string;
  fund: string;
  asset_type: ParsedAsset['assetType'];
  /** Persisted target table; absent on historical reviews. */
  target_kind?: 'fund' | 'asset';
  entity: string | null;
  funding_source: string | null;
  matched_fund: FundUpdateCatalogMatch | null;
  matched_investor: FundUpdateCatalogMatch | null;
  matched_source: FundUpdateCatalogMatch | null;
  status: FundUpdateAssetStatus;
  matched_asset_id: string | null;
  proposed_txn_count: number;
  proposed_valuation_count: number;
  existing_txn_count: number;
  existing_valuation_count: number;
  missing_txn_count: number;
  missing_valuation_count: number;
  /** Full proposed asset (for Overview / tabs). */
  proposed: ParsedAsset;
  /** Txns that would be inserted on approve. */
  missing_txns: ParsedTxn[];
  /** Valuations whose as_of_date is not yet on the matched asset. */
  missing_valuations: ParsedValuation[];
}

export interface FundUpdateFullReview {
  assets: FundUpdateAssetReview[];
  funds: FundUpdateCatalogMatch[];
  investors: FundUpdateCatalogMatch[];
  sources: FundUpdateCatalogMatch[];
  groups?: FundUpdateCatalogMatch[];
  reconciliation?: ReconciliationResult[];
  review_items?: ReviewProposalItem[];
  commitment_event_statuses?: Record<number, 'actionable' | 'duplicate'>;
  /**
   * Canonical names of the managed funds (catalog, holder funds, and managed funds
   * already in the workspace). A managed fund party on a commitment-path row is a
   * fund holder, not an investor.
   */
  managed_fund_keys?: string[];
  two_step_review?: FundUpdateTwoStepReview;
}

export type WizardStep = 1 | 2;

export type EntityTabKind = 'asset' | 'fund' | 'investor' | 'source';
export type Step2TabKind = 'transactions' | 'valuations' | 'reconciliation';

export type EntityStatus = 'new' | 'matched' | 'blocked';

export interface EntityLink {
  key: string;
  kind: string; // 'Asset' | 'Fund' | 'Investor' | 'Source of Fund'
  name: string;
  status: EntityStatus;
}

export interface EntityField {
  label: string;
  value: string | number | null | undefined;
}

export interface ReviewEntity {
  key: string; // e.g. "asset:01FN", "fund:Startech Growth Fund 1", "investor:SMMA", "source:DCA"
  tab: EntityTabKind;
  code: string;
  name: string;
  englishName?: string | null;
  status: EntityStatus;
  matchedId: string | null;
  autoCreated?: boolean;
  role?: string | null;
  isGroup?: boolean;
  groupName?: string | null;
  txnsCount: number;
  valsCount: number;
  fields: EntityField[];
  links: EntityLink[];
  isStaged: boolean; // Staged selection semantics only: nothing persists before final approval
  rawAsset?: FundUpdateAssetReview;
  rawAssets?: FundUpdateAssetReview[];
  rawCatalog?: FundUpdateCatalogMatch;
  isRemapped?: boolean;
  remappedTo?: {
    id: string | null;
    name: string;
    isNew?: boolean;
  };
  matchedIdConflict?: { id1: string; id2: string } | null;
  blockReason?: string | null;
}

export interface StagedReviewEntityInput {
  key: string;
  name?: string;
  kind?: string;
  tab?: EntityTabKind;
  status?: EntityStatus;
  matchedId?: string | null;
  isStaged?: boolean;
  isGroup?: boolean;
  rawAssets?: FundUpdateAssetReview[];
  matchedIdConflict?: { id1: string; id2: string } | null;
  blockReason?: string | null;
}

export interface ReviewTransactionLeg {
  from: string;
  to: string;
  type: string;
  amount: number;
  units?: number;
  pps?: number;
  note?: string;
}

export interface MultiTransferAllocation {
  id: string;
  transferorName: string;
  amount: number | string;
}

export interface NonCashAdjustmentState {
  enabled: boolean;
  investorName: string;
  direction: 'reduction' | 'addition';
  subType: string;
}

export interface SingleTransferState {
  enabled: boolean;
  transferorName: string;
}

export type BusinessEventBackingRef =
  | { kind: 'asset_txn'; assetCode: string; txnIndex: number; originalKey?: string }
  | { kind: 'commitment_event'; sourceRow: number; intent: string }
  | { kind: 'review_item'; sourceRow: number; category?: string }
  | { kind: 'v1_event'; proposalId: string; eventType: string };

export type ValuationBackingRef =
  | { kind: 'asset_valuation'; assetCode: string; valIndex: number; originalKey?: string }
  | { kind: 'v1_valuation'; proposalId: string };

export interface ReviewTransaction {
  id: string;
  sheetRow: number | string;
  date: string;
  fromKey: string;
  toKey: string;
  srcKey: string | null;
  sourceKey?: string | null;
  type: string;
  subType: string;
  commitDelta: number | null;
  quantityDelta: number | null;
  pricePerShare: number | null;
  cashDelta: number | null;
  currency: string;
  amount?: number | null;
  positionRef: string | null;
  status: 'actionable' | 'duplicate' | 'blocked';
  blockReason?: string | null;
  selected: boolean;
  isResolved?: boolean;
  backingRef?: BusinessEventBackingRef;
  // Transfer support: transfers are selected as one business event; approval posts all internal legs together
  isTransfer: boolean;
  isMultiPartyTransfer?: boolean;
  allocations?: MultiTransferAllocation[];
  singleTransferState?: SingleTransferState;
  legs?: ReviewTransactionLeg[];
  // Non-cash adjustment support
  isNonCashAdjustment?: boolean;
  nonCashState?: NonCashAdjustmentState;
  // Backing pointers
  assetCode?: string;
  originalKey?: string;
  notes?: string | null;
  /**
   * Non-blocking review annotation shown in the reason column. Review annotates,
   * apply decides: e.g. a managed fund's 投资 into another managed fund stays
   * selectable and is noted as recorded from the target fund's paid-in rows.
   */
  reviewNote?: string | null;
  subTypeLabel?: string | null;
  /**
   * Effective sell proceeds destination for divestment rows. When the source left
   * destination unmarked, this is null and the UI renders the effective default.
   */
  sellProceedsDestination?: SellProceedsDestination | null;
  rawTxn?: ParsedTxn;
  rawReviewItem?: ReviewProposalItem;
  rawCommitmentEvent?: ParsedCommitmentEvent;
  rawEvent?: ProposedEvent;
}

export type ReviewBusinessEvent = ReviewTransaction;

export interface ReviewValuation {
  id: string;
  sheetRow: number | string;
  targetKey?: string;
  holderKey?: string;
  assetCode: string;
  assetName: string;
  asOfDate: string;
  periodLabel: string;
  marketValue: number | null;
  pricePerShare: number | null;
  sharesOutstanding: number | null;
  shareholdingPct: number | null;
  valuationMethod: string | null;
  currency: string;
  notes?: string | null;
  status: 'actionable' | 'duplicate' | 'blocked';
  blockReason?: string | null;
  selected: boolean;
  backingRef?: ValuationBackingRef;
  originalKey: string;
  rawVal?: ParsedValuation;
  rawValuation?: ProposedValuation;
}

export interface ReviewReconciliation {
  fund?: string | null;
  metricName: string;
  sourceValue: number;
  calculatedValue: number;
  diff: number;
  diffPct: number;
  currency?: string;
  isReconciled: boolean;
  notes?: string | null;
}

export interface ReviewOption {
  key: string;
  name: string;
  englishName?: string | null;
  group: string;
  isNew?: boolean;
}

export interface FundUpdateTwoStepReview {
  entities: ReviewEntity[];
  transactions: ReviewBusinessEvent[];
  valuations: ReviewValuation[];
  reconciliation: ReviewReconciliation[];
}

export type NormalizedTwoStepReview = FundUpdateTwoStepReview;

export interface ReviewBusinessEventEdits {
  date?: string;
  amount?: number;
  currency?: string;
  cashDelta?: number | null;
  quantityDelta?: number | null;
  pricePerShare?: number | null;
  notes?: string | null;
  transferorName?: string;
  allocations?: Array<{ transferorName: string; amount: number }>;
  investorName?: string;
  direction?: 'reduction' | 'addition';
  subType?: string;
  type?: string;
  subTypeLabel?: string | null;
  /**
   * Reviewer-stated proceeds destination. Presence means stated (clears the
   * inferred flag on apply). Omit when the destination remains inferred.
   */
  sellProceedsDestination?: SellProceedsDestination | null;
}

export interface ReviewValuationEdits {
  asOfDate?: string;
  marketValue?: number | null;
  pricePerShare?: number | null;
  sharesOutstanding?: number | null;
  shareholdingPct?: number | null;
  valuationMethod?: string | null;
  notes?: string | null;
}

export type SubmittedRowFamily =
  | 'transaction'
  | 'valuation'
  | 'commitment'
  | 'review_item'
  | 'commitment_event'
  | 'review_resolution';
export type SubmittedRowDisposition = 'posted' | 'duplicate' | 'rejected' | 'stale' | 'partial';

export interface SubmittedRowOutcome {
  submittedId: string;
  family: SubmittedRowFamily;
  disposition: SubmittedRowDisposition;
  reason?: string | null;
  assetCode?: string | null;
  targetId?: string | null;
  persistedId?: string | null;
  persistedTable?: 'fl_ledger_entries' | 'fl_valuations' | 'fl_commitment_events' | 'fl_business_events' | null;
  warnings?: string[];
  childOutcomes?: SubmittedRowOutcome[];
}

export interface FundUpdateTwoStepApproval {
  entityDecisions: Array<{
    key: string;
    action: 'use_existing' | 'create' | 'omit';
    matchedId?: string | null;
    remappedName?: string | null;
  }>;
  transactions: Array<{
    id: string;
    edits?: ReviewBusinessEventEdits;
  }>;
  valuations: Array<{
    id: string;
    edits?: ReviewValuationEdits;
  }>;
}

export interface FundUpdateStats {
  asset_count: number;
  direct_count: number;
  fund_of_funds_count: number;
  transaction_count: number;
  valuation_count: number;
  commitment_event_count?: number;
  total_data_rows?: number;
  parsed_rows_count?: number;
  excluded_rows_count?: number;
  ambiguous_rows_count?: number;
  coverage_pct?: number;
  entity_count?: number;
  event_count?: number;
}

export interface FundUpdateReviewData {
  kind: 'fund_updates';
  file: {
    id: string;
    file_name: string;
    file_type: string | null;
    processing_status: string;
  };
  template_id: string | null;
  stats: FundUpdateStats | null;
  summary: string | null;
  two_step_review: FundUpdateTwoStepReview;
}
