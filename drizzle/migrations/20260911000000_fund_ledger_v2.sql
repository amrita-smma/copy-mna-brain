-- Fund Ledger v2: Enums, Tables, Indexes, Constraints, and Append-only Trigger
-- Source: FUND_LEDGER_IMPLEMENTATION_PLAN.md (Phase 1)

-- ==========================================
-- 1. Enums (prefix fl_)
-- ==========================================

CREATE TYPE fl_investor_type AS ENUM (
  'individual',
  'institution',
  'internal_entity'
);

CREATE TYPE fl_ownership_basis AS ENUM (
  'units',
  'commitment',
  'capital_account'
);

CREATE TYPE fl_fund_status AS ENUM (
  'raising',
  'investing',
  'harvesting',
  'liquidated'
);

CREATE TYPE fl_asset_kind AS ENUM (
  'equity',
  'loan',
  'note',
  'safe',
  'real_estate',
  'listed_security',
  'cash',
  'other'
);

CREATE TYPE fl_position_status AS ENUM (
  'open',
  'closed'
);

CREATE TYPE fl_entry_type AS ENUM (
  'commitment',
  'commitment_transfer',
  'paid_in',
  'distribution',
  'redemption',
  'unit_transfer',
  'buy',
  'sell',
  'income',
  'expense',
  'adjustment'
);

CREATE TYPE fl_event_status AS ENUM (
  'posted',
  'reversed'
);

CREATE TYPE fl_data_status AS ENUM (
  'verified',
  'needs_verification'
);

CREATE TYPE fl_valuation_method AS ENUM (
  'at_cost',
  'fundraise_round',
  'secondary_sale',
  'listed_price',
  'comparables',
  'capital_account_statement',
  'appraisal',
  'other'
);

-- ==========================================
-- 2. Tables (10)
-- ==========================================

-- 1) fl_investors
CREATE TABLE fl_investors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  legal_name TEXT,
  investor_type fl_investor_type NOT NULL,
  country TEXT,
  parent_investor_id UUID REFERENCES fl_investors(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_fl_investors_workspace_id ON fl_investors (workspace_id);
CREATE UNIQUE INDEX fl_investors_workspace_canonical_name_uniq
  ON fl_investors (workspace_id, canonical_name);

CREATE TRIGGER update_fl_investors_updated_at
  BEFORE UPDATE ON fl_investors
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 2) fl_funds
CREATE TABLE fl_funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  legal_name TEXT,
  registration_no TEXT,
  managed BOOLEAN NOT NULL DEFAULT false,
  ownership_basis fl_ownership_basis NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'USD',
  vintage_year INTEGER,
  fund_life_years INTEGER,
  status fl_fund_status NOT NULL DEFAULT 'investing',
  mgmt_fee_rate NUMERIC(9,6),
  carry_rate NUMERIC(9,6),
  preferred_return_rate NUMERIC(9,6),
  description TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_fl_funds_workspace_id ON fl_funds (workspace_id);
CREATE UNIQUE INDEX fl_funds_workspace_canonical_name_uniq
  ON fl_funds (workspace_id, canonical_name);

CREATE TRIGGER update_fl_funds_updated_at
  BEFORE UPDATE ON fl_funds
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 3) fl_assets
CREATE TABLE fl_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  legal_name TEXT,
  english_name TEXT,
  asset_kind fl_asset_kind NOT NULL,
  country TEXT,
  sector TEXT,
  sub_sector TEXT,
  instrument_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_fl_assets_workspace_id ON fl_assets (workspace_id);
CREATE UNIQUE INDEX fl_assets_workspace_canonical_name_uniq
  ON fl_assets (workspace_id, canonical_name);

CREATE TRIGGER update_fl_assets_updated_at
  BEFORE UPDATE ON fl_assets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 4) fl_funding_sources
CREATE TABLE fl_funding_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  source_type TEXT,
  owner_investor_id UUID REFERENCES fl_investors(id) ON DELETE SET NULL,
  currency CHAR(3),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_fl_funding_sources_workspace_id ON fl_funding_sources (workspace_id);
CREATE UNIQUE INDEX fl_funding_sources_workspace_canonical_name_uniq
  ON fl_funding_sources (workspace_id, canonical_name);

CREATE TRIGGER update_fl_funding_sources_updated_at
  BEFORE UPDATE ON fl_funding_sources
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 5) fl_positions
CREATE TABLE fl_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  holder_investor_id UUID REFERENCES fl_investors(id) ON DELETE CASCADE,
  holder_fund_id UUID REFERENCES fl_funds(id) ON DELETE CASCADE,
  fund_id UUID REFERENCES fl_funds(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES fl_assets(id) ON DELETE CASCADE,
  holder_source_of_fund_id UUID REFERENCES fl_funding_sources(id) ON DELETE RESTRICT,
  status fl_position_status NOT NULL DEFAULT 'open',
  opened_at DATE,
  closed_at DATE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fl_positions_natural_key_uniq UNIQUE NULLS NOT DISTINCT (holder_investor_id, holder_fund_id, fund_id, asset_id, holder_source_of_fund_id)
);

CREATE INDEX idx_fl_positions_workspace_id ON fl_positions (workspace_id);
CREATE INDEX idx_fl_positions_fund_id ON fl_positions (fund_id);
CREATE INDEX idx_fl_positions_asset_id ON fl_positions (asset_id);
CREATE INDEX idx_fl_positions_holder_investor_id ON fl_positions (holder_investor_id);
CREATE INDEX idx_fl_positions_holder_fund_id ON fl_positions (holder_fund_id);
CREATE INDEX idx_fl_positions_holder_source_of_fund_id ON fl_positions (holder_source_of_fund_id);

CREATE TRIGGER update_fl_positions_updated_at
  BEFORE UPDATE ON fl_positions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 6) fl_source_records
CREATE TABLE fl_source_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  sheet_name TEXT,
  row_number INTEGER,
  raw_payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  imported_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fl_source_records_payload_uniq UNIQUE NULLS NOT DISTINCT (workspace_id, file_id, sheet_name, row_number, payload_hash)
);

CREATE INDEX idx_fl_source_records_workspace_id ON fl_source_records (workspace_id);

CREATE TRIGGER update_fl_source_records_updated_at
  BEFORE UPDATE ON fl_source_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 7) fl_business_events
CREATE TABLE fl_business_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  description TEXT,
  status fl_event_status NOT NULL DEFAULT 'posted',
  reversal_of_event_id UUID REFERENCES fl_business_events(id) ON DELETE SET NULL,
  source_record_id UUID REFERENCES fl_source_records(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_fl_business_events_workspace_id ON fl_business_events (workspace_id);

CREATE TRIGGER update_fl_business_events_updated_at
  BEFORE UPDATE ON fl_business_events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 8) fl_ledger_entries
CREATE TABLE fl_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES fl_positions(id) ON DELETE RESTRICT,
  business_event_id UUID NOT NULL REFERENCES fl_business_events(id) ON DELETE RESTRICT,
  entry_date DATE NOT NULL,
  entry_type fl_entry_type NOT NULL,
  sub_type TEXT,
  is_reversal BOOLEAN NOT NULL DEFAULT false,
  commitment_delta NUMERIC(38,8) NOT NULL DEFAULT 0,
  quantity_delta NUMERIC(38,8) NOT NULL DEFAULT 0,
  cash_delta NUMERIC(38,8) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL,
  fx_rate NUMERIC(38,12),
  price_per_unit NUMERIC(38,8),
  counterparty_position_id UUID REFERENCES fl_positions(id) ON DELETE RESTRICT,
  data_status fl_data_status NOT NULL DEFAULT 'verified',
  source_record_id UUID REFERENCES fl_source_records(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_fl_ledger_entries_position_entry_date ON fl_ledger_entries (position_id, entry_date);
CREATE INDEX idx_fl_ledger_entries_business_event_id ON fl_ledger_entries (business_event_id);

-- 9) fl_ledger_entry_funding_allocations
CREATE TABLE fl_ledger_entry_funding_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id UUID NOT NULL REFERENCES fl_ledger_entries(id) ON DELETE CASCADE,
  funding_source_id UUID NOT NULL REFERENCES fl_funding_sources(id) ON DELETE RESTRICT,
  amount NUMERIC(38,8) NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fl_ledger_entry_funding_allocations_entry_source_uniq UNIQUE (ledger_entry_id, funding_source_id)
);

CREATE INDEX idx_fl_allocations_funding_source_id ON fl_ledger_entry_funding_allocations (funding_source_id);

-- 10) fl_valuations
CREATE TABLE fl_valuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID REFERENCES fl_assets(id) ON DELETE CASCADE,
  fund_id UUID REFERENCES fl_funds(id) ON DELETE CASCADE,
  position_id UUID REFERENCES fl_positions(id) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  valuation_method fl_valuation_method,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  market_value NUMERIC(38,8),
  price_per_unit NUMERIC(38,8),
  units_outstanding NUMERIC(38,8),
  gross_value NUMERIC(38,8),
  net_value NUMERIC(38,8),
  data_status fl_data_status NOT NULL DEFAULT 'verified',
  source_record_id UUID REFERENCES fl_source_records(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fl_valuations_target_date_uniq UNIQUE NULLS NOT DISTINCT (asset_id, fund_id, position_id, as_of_date)
);

CREATE INDEX idx_fl_valuations_asset_id ON fl_valuations (asset_id);
CREATE INDEX idx_fl_valuations_fund_id ON fl_valuations (fund_id);
CREATE INDEX idx_fl_valuations_position_id ON fl_valuations (position_id);
CREATE INDEX idx_fl_valuations_as_of_date ON fl_valuations (as_of_date);

CREATE TRIGGER update_fl_valuations_updated_at
  BEFORE UPDATE ON fl_valuations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
