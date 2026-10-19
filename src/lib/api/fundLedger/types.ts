import type { Tables } from '@/lib/repositories';
import type {
  FlPortfolioLedgerEntry,
  FlPortfolioPosition,
  FlPortfolioReadModel,
} from '@/lib/services/flPortfolioService';
import type { PositionBalances } from '@/lib/services/flBalanceService';

export type {
  FlPortfolioLedgerEntry,
  FlPortfolioPosition,
  FlPortfolioReadModel,
  PositionBalances,
};

export type FundStatus = 'raising' | 'investing' | 'harvesting' | 'liquidated';
export type OwnershipBasis = 'units' | 'commitment' | 'capital_account';
export type AssetKind =
  | 'equity'
  | 'loan'
  | 'note'
  | 'safe'
  | 'real_estate'
  | 'listed_security'
  | 'cash'
  | 'other';
export type InvestorType = 'individual' | 'institution' | 'internal_entity';
export type PositionStatus = 'open' | 'closed';
export type ValuationMethod =
  | 'at_cost'
  | 'fundraise_round'
  | 'secondary_sale'
  | 'listed_price'
  | 'comparables'
  | 'capital_account_statement'
  | 'appraisal'
  | 'other';
export type EntryType =
  | 'commitment'
  | 'commitment_transfer'
  | 'paid_in'
  | 'distribution'
  | 'redemption'
  | 'unit_transfer'
  | 'buy'
  | 'sell'
  | 'income'
  | 'expense'
  | 'adjustment'
  | 'cash_movement';

// ---- Funds ----

export interface CreateFundInput {
  name: string;
  legal_name?: string | null;
  english_name?: string | null;
  registration_no?: string | null;
  managed?: boolean;
  ownership_basis?: OwnershipBasis;
  base_currency?: string;
  vintage_year?: number | null;
  fund_life_years?: number | null;
  status?: FundStatus;
  mgmt_fee_rate?: string | null;
  carry_rate?: string | null;
  preferred_return_rate?: string | null;
  description?: string | null;
}

export interface UpdateFundInput {
  name?: string;
  legal_name?: string | null;
  english_name?: string | null;
  registration_no?: string | null;
  managed?: boolean;
  ownership_basis?: OwnershipBasis;
  base_currency?: string;
  vintage_year?: number | null;
  fund_life_years?: number | null;
  status?: FundStatus;
  mgmt_fee_rate?: string | null;
  carry_rate?: string | null;
  preferred_return_rate?: string | null;
  description?: string | null;
}

// ---- Assets ----

export interface CreateAssetInput {
  name: string;
  legal_name?: string | null;
  english_name?: string | null;
  asset_kind: AssetKind;
  country?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
  instrument_terms?: Record<string, unknown>;
  description?: string | null;
}

export interface UpdateAssetInput {
  name?: string;
  legal_name?: string | null;
  english_name?: string | null;
  asset_kind?: AssetKind;
  country?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
  instrument_terms?: Record<string, unknown>;
  description?: string | null;
  action_items?: string | null;
}

/** Counts removed by a hard asset delete. */
export interface DeleteAssetResult {
  entries: number;
  events: number;
  positions: number;
}

// ---- Investors ----

export interface CreateInvestorInput {
  name: string;
  investor_type: InvestorType;
  legal_name?: string | null;
  english_name?: string | null;
  tax_id?: string | null;
  country?: string | null;
  parent_investor_id?: string | null;
  kyc_status?: string | null;
  notes?: string | null;
}

export interface UpdateInvestorInput {
  name?: string;
  investor_type?: InvestorType;
  legal_name?: string | null;
  english_name?: string | null;
  tax_id?: string | null;
  country?: string | null;
  parent_investor_id?: string | null;
  kyc_status?: string | null;
  notes?: string | null;
}

// ---- Funding Sources ----

export interface CreateFundingSourceInput {
  name: string;
  source_type?: string;
  currency?: string | null;
  description?: string | null;
}

export interface UpdateFundingSourceInput {
  name?: string;
  source_type?: string;
  currency?: string | null;
  description?: string | null;
}

// ---- Positions ----

export interface OpenPositionInput {
  holder_investor_id?: string | null;
  holder_fund_id?: string | null;
  fund_id?: string | null;
  asset_id?: string | null;
  holder_source_of_fund_id?: string | null;
  opened_at?: string | null;
  notes?: string | null;
}

// ---- Ledger Events & Entries ----

export interface LedgerEntryInput {
  id?: string;
  position_id: string;
  entry_date: string;
  entry_type: EntryType;
  sub_type?: string | null;
  commitment_delta?: string;
  quantity_delta?: string;
  valuation_delta?: string;
  cash_delta?: string;
  currency: string;
  fx_rate?: string | null;
  price_per_unit?: string | null;
  counterparty_position_id?: string | null;
  data_status?: 'verified' | 'needs_verification';
  source_record_id?: string | null;
  source_ledger_entry_id?: string | null;
  primary_entry_index?: number | null;
  source_entry_index?: number | null;
  notes?: string | null;
  allocations?: {
    funding_source_id: string;
    amount: string;
  }[];
}

export interface PostEventInput {
  event_date: string;
  description?: string | null;
  source_record_id?: string | null;
  entries: LedgerEntryInput[];
  allocations?: {
    entry_index: number;
    funding_source_id: string;
    amount: string;
  }[];
}

export interface UpdateEventInput {
  event_date: string;
  description?: string | null;
  source_record_id?: string | null;
  entries: LedgerEntryInput[];
}

export interface ReverseEventInput {
  description?: string;
  event_date?: string;
}

// ---- Valuations ----

export interface RecordValuationInput {
  asset_id?: string | null;
  fund_id?: string | null;
  position_id?: string | null;
  as_of_date: string;
  valuation_method?: ValuationMethod | null;
  currency?: string;
  market_value?: string | null;
  price_per_unit?: string | null;
  units_outstanding?: string | null;
  gross_value?: string | null;
  net_value?: string | null;
  data_status?: 'verified' | 'needs_verification';
  source_record_id?: string | null;
  notes?: string | null;
}

export interface UpdateValuationInput {
  asset_id?: string | null;
  fund_id?: string | null;
  position_id?: string | null;
  as_of_date?: string;
  valuation_method?: ValuationMethod | null;
  currency?: string;
  market_value?: string | null;
  price_per_unit?: string | null;
  units_outstanding?: string | null;
  gross_value?: string | null;
  net_value?: string | null;
  data_status?: 'verified' | 'needs_verification';
  source_record_id?: string | null;
  notes?: string | null;
}

// ---- Commitments ----

export type CommitmentEventType =
  | 'initial_commitment'
  | 'additional_commitment'
  | 'reduction'
  | 'transfer_in'
  | 'transfer_out';

export interface CommitmentEventWithBalance {
  id: string;
  fund_id: string;
  holding_entity_id: string;
  effective_date: string;
  event_type: CommitmentEventType;
  amount: number;
  currency: string;
  counterparty_holding_entity_id?: string | null;
  transfer_group_id?: string | null;
  notes?: string | null;
  source?: string | null;
  runningBalance: number;
  created_at: string;
}
