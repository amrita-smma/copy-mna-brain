import type { ParsedAsset, ParsedTxn, ParsedValuation, StartechParseResult } from './parsers/startech_quarterly';
export type { ParsedAsset, ParsedTxn, ParsedValuation, StartechParseResult };

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

export interface ReconciliationResult {
  metricName: string;
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
}

export interface LegacyAssetProposal {
  template_id: string;
  stats: StartechParseResult['stats'];
  assets: ParsedAsset[];
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
