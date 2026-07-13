-- Fund Management feature — funds, the assets each fund holds, their
-- transaction ledgers, valuation history, and fund-level performance
-- rollups. Fully additive: no existing table is touched.
-- Spec: Confluence 2641362965 ("Fund Management — Database Schema (ERD)").
--
-- investors / fund_investor_stakes / fund_asset_investor_stakes back a
-- future by-investor view — created here ahead of that view (per an inline
-- reviewer request), but no repository/service/UI reads from them yet.
--
-- Every table carries created_by/updated_by (nullable FK to users, ON
-- DELETE SET NULL) alongside created_at/updated_at, for a consistent audit
-- trail across this financial feature — matches the pattern already used
-- by `routines`. Nullable because background jobs (FundMetricsService
-- rollups) and seed data write these tables with no acting user.
--
-- Workspace scoping (MB-337 pattern): `funds` and `investors` are root
-- tables and carry a real, NOT NULL `workspace_id`. Every other table here
-- is a NOT NULL child of `funds` or `fund_assets` and deliberately has NO
-- own `workspace_id` column — it scopes via a join/subquery through its
-- parent instead, same as `company_financials` scopes through `companies`.

CREATE TYPE fund_status AS ENUM ('investing', 'harvesting');

CREATE TYPE asset_type AS ENUM ('direct_investment', 'cash', 'fund_of_funds');

CREATE TYPE asset_status AS ENUM ('active', 'exiting', 'exited');

CREATE TYPE transaction_type AS ENUM (
  'contribution', 'divestment', 'distribution', 'interest_income',
  'return_of_capital', 'other'
);

CREATE TYPE valuation_method AS ENUM (
  'at_cost', 'fundraise_round', 'secondary_sale', 'stock_market_price',
  'comparables', 'capital_account_statement', 'other'
);

-- The fund vehicle. Root table — carries its own workspace_id.
CREATE TABLE funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  vintage_year INTEGER,
  commitment_size_amount NUMERIC,
  status fund_status NOT NULL DEFAULT 'investing',
  base_currency TEXT NOT NULL DEFAULT 'USD',
  called_amount NUMERIC,
  fmv_amount NUMERIC,
  realized_amount NUMERIC,
  dpi NUMERIC,
  tvpi NUMERIC,
  irr NUMERIC,
  metrics_computed_at TIMESTAMP WITH TIME ZONE,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT funds_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT funds_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_funds_workspace_id ON funds (workspace_id);

CREATE TRIGGER update_funds_updated_at
  BEFORE UPDATE ON funds
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- An LP (investor) — backs the future by-investor view (see header note).
-- Root table — carries its own workspace_id (an LP belongs to one tenant).
CREATE TABLE investors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  investor_type TEXT,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT investors_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT investors_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_investors_workspace_id ON investors (workspace_id);

CREATE TRIGGER update_investors_updated_at
  BEFORE UPDATE ON investors
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- The asset — a company, cash reserve, loan, or fund interest a fund holds.
-- Deliberately has no FK to companies (§2 design principle 1): fund
-- reporting stays independent of pipeline lifecycle events. No own
-- workspace_id (child of funds via the NOT NULL fund_id below).
CREATE TABLE fund_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL,
  asset_type asset_type NOT NULL,
  asset_name TEXT,
  legal_name TEXT,
  country TEXT,
  funding_source TEXT,
  investment_type TEXT,
  entry_date DATE,
  maturity_date DATE,
  commitment_amount NUMERIC,
  stake_pct NUMERIC,
  sector TEXT,
  sub_sector TEXT,
  investment_currency TEXT DEFAULT 'USD',
  report_currency TEXT DEFAULT 'USD',
  investment_description TEXT,
  key_rights TEXT,
  subscription_fee_amount NUMERIC,
  mgmt_fee_rate_pct NUMERIC,
  carry_rate_pct NUMERIC,
  legal_fees_amount NUMERIC,
  type_details JSONB DEFAULT '{}'::jsonb,
  status asset_status NOT NULL DEFAULT 'active',
  current_price_per_share NUMERIC,
  share_count NUMERIC,
  gross_moic NUMERIC,
  gross_irr NUMERIC,
  dpi NUMERIC,
  invested_capital_amount NUMERIC,
  net_distribution_amount NUMERIC,
  metrics_computed_at TIMESTAMP WITH TIME ZONE,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_assets_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE,
  CONSTRAINT fund_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fund_assets_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_fund_assets_fund_id ON fund_assets (fund_id);

CREATE TRIGGER update_fund_assets_updated_at
  BEFORE UPDATE ON fund_assets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- An LP's commitment-based stake in a fund (not unitized — see §5.6: no
-- share_count here, ownership % is derived as commitment_amount / SUM(...)).
-- commitment_amount (pledged) and invested_amount (actually called/drawn
-- down) are tracked separately, each with its own currency. No own
-- workspace_id (child of funds via the NOT NULL fund_id below).
CREATE TABLE fund_investor_stakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL,
  investor_id UUID NOT NULL,
  commitment_amount NUMERIC,
  commitment_amount_currency TEXT DEFAULT 'USD',
  invested_amount NUMERIC,
  invested_amount_currency TEXT DEFAULT 'USD',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_investor_stakes_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE,
  CONSTRAINT fund_investor_stakes_investor_id_fkey FOREIGN KEY (investor_id) REFERENCES investors(id) ON DELETE CASCADE,
  CONSTRAINT fund_investor_stakes_fund_investor_uniq UNIQUE (fund_id, investor_id),
  CONSTRAINT fund_investor_stakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fund_investor_stakes_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- No separate single-column index on fund_id: the composite unique index
-- above already serves fund_id-only lookups via leftmost-prefix matching.

CREATE TRIGGER update_fund_investor_stakes_updated_at
  BEFORE UPDATE ON fund_investor_stakes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- The ledger — every cash flow into or out of an asset. No own
-- workspace_id (child of fund_assets via the NOT NULL fund_asset_id below).
CREATE TABLE fund_asset_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_asset_id UUID NOT NULL,
  txn_date DATE NOT NULL,
  txn_type transaction_type NOT NULL,
  sub_type_label TEXT,
  price_per_share NUMERIC,
  share_count NUMERIC,
  value_amount NUMERIC,
  txn_currency TEXT,
  fx_rate NUMERIC,
  notes TEXT,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_asset_transactions_fund_asset_id_fkey FOREIGN KEY (fund_asset_id) REFERENCES fund_assets(id) ON DELETE CASCADE,
  CONSTRAINT fund_asset_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fund_asset_transactions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_fund_asset_transactions_fund_asset_id ON fund_asset_transactions (fund_asset_id);

CREATE TRIGGER update_fund_asset_transactions_updated_at
  BEFORE UPDATE ON fund_asset_transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- A point-in-time snapshot of an asset's value and derived metrics. No own
-- workspace_id (child of fund_assets via the NOT NULL fund_asset_id below).
CREATE TABLE fund_asset_valuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_asset_id UUID NOT NULL,
  as_of_date DATE NOT NULL,
  period_label TEXT,
  valuation_method valuation_method,
  currency TEXT DEFAULT 'USD',
  market_value_amount NUMERIC,
  price_per_share NUMERIC,
  shares_outstanding NUMERIC,
  shareholding_pct NUMERIC,
  invested_capital_cum_amount NUMERIC,
  net_distribution_amount NUMERIC,
  gross_moic NUMERIC,
  dpi NUMERIC,
  gross_xirr NUMERIC,
  notes TEXT,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_asset_valuations_fund_asset_id_fkey FOREIGN KEY (fund_asset_id) REFERENCES fund_assets(id) ON DELETE CASCADE,
  CONSTRAINT fund_asset_valuations_asset_date_uniq UNIQUE (fund_asset_id, as_of_date),
  CONSTRAINT fund_asset_valuations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fund_asset_valuations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- No separate single-column index on fund_asset_id: the composite unique
-- index above already serves fund_asset_id-only lookups (leftmost-prefix).

CREATE TRIGGER update_fund_asset_valuations_updated_at
  BEFORE UPDATE ON fund_asset_valuations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- An investor's direct co-investment in one specific asset, bypassing the
-- fund's own commitment structure. Unlike fund_investor_stakes, this one
-- has a real share_count (§5.6). No own workspace_id (child of fund_assets
-- via the NOT NULL fund_asset_id below).
CREATE TABLE fund_asset_investor_stakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_asset_id UUID NOT NULL,
  investor_id UUID NOT NULL,
  commitment_amount NUMERIC,
  currency TEXT DEFAULT 'USD',
  share_count NUMERIC,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_asset_investor_stakes_fund_asset_id_fkey FOREIGN KEY (fund_asset_id) REFERENCES fund_assets(id) ON DELETE CASCADE,
  CONSTRAINT fund_asset_investor_stakes_investor_id_fkey FOREIGN KEY (investor_id) REFERENCES investors(id) ON DELETE CASCADE,
  CONSTRAINT fund_asset_investor_stakes_asset_investor_uniq UNIQUE (fund_asset_id, investor_id),
  CONSTRAINT fund_asset_investor_stakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fund_asset_investor_stakes_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- No separate single-column index on fund_asset_id: the composite unique
-- index above already serves fund_asset_id-only lookups (leftmost-prefix).

CREATE TRIGGER update_fund_asset_investor_stakes_updated_at
  BEFORE UPDATE ON fund_asset_investor_stakes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Fund-level history: the same time-series shape as fund_asset_valuations,
-- aggregated to the fund. No own workspace_id (child of funds via the NOT
-- NULL fund_id below).
CREATE TABLE fund_valuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL,
  as_of_date DATE NOT NULL,
  period_label TEXT,
  currency TEXT DEFAULT 'USD',
  committed_amount NUMERIC,
  called_amount NUMERIC,
  fmv_amount NUMERIC,
  realized_amount NUMERIC,
  gross_moic NUMERIC,
  gross_irr NUMERIC,
  dpi NUMERIC,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_valuations_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE,
  CONSTRAINT fund_valuations_fund_date_uniq UNIQUE (fund_id, as_of_date),
  CONSTRAINT fund_valuations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fund_valuations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TRIGGER update_fund_valuations_updated_at
  BEFORE UPDATE ON fund_valuations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
