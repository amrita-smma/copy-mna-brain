-- Midas data mart: a read-only window onto the fund ledger (fl_*) for Star
-- Capital's Midas, limited to two workspaces. Midas connects as midas_reader
-- over RDS IAM auth and can read only the `midas` schema.
--
-- Each view has the same name and columns as the public table it reads, so the
-- ERD and the app schema describe it as well. These are plain views, so Midas
-- always sees live data and there is nothing to refresh. A view runs with its
-- owner's privileges, so midas_reader needs SELECT on the views only, never on
-- the fl_* tables.
--
-- security_barrier stops a reader's own functions in a WHERE clause from being
-- run before the workspace filter, which could otherwise leak filtered-out rows.
--
-- Workspaces included (the same three IDs appear in every view below):
--   d201c012-2b04-490d-a236-fbf605bcf333  production
--   2e42f936-a20e-4d73-96ad-4ad4aab0c266  staging
--   00000000-0000-0000-0000-000000000005  dev: "Used for Midas", created by
--                                          scripts/seed.ts (MIDAS_WORKSPACE_ID)
-- Each environment holds only its own workspace, so the extra IDs match
-- nothing there. To change the list, recreate the views in a new migration.

CREATE SCHEMA IF NOT EXISTS midas;

COMMENT ON SCHEMA midas IS
  'Read-only fund ledger data mart for Star Capital Midas. Views over public.fl_*, limited to the in-scope workspaces.';

-- Investors (LPs, holding entities, internal entities) -----------------------
CREATE OR REPLACE VIEW midas.fl_investors WITH (security_barrier = true) AS
SELECT
  i.id, i.workspace_id, i.name, i.canonical_name, i.legal_name, i.english_name,
  i.investor_type, i.country, i.parent_investor_id, i.notes,
  i.created_at, i.updated_at
FROM public.fl_investors i
WHERE i.workspace_id IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- Sources of funds ------------------------------------------------------------
CREATE OR REPLACE VIEW midas.fl_funding_sources WITH (security_barrier = true) AS
SELECT
  s.id, s.workspace_id, s.name, s.canonical_name, s.source_type,
  s.owner_investor_id, s.currency, s.created_at, s.updated_at
FROM public.fl_funding_sources s
WHERE s.workspace_id IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- Investment types (asset grouping) -------------------------------------------
CREATE OR REPLACE VIEW midas.fl_investment_types WITH (security_barrier = true) AS
SELECT t.id, t.workspace_id, t.name, t.sort_order, t.created_at, t.updated_at
FROM public.fl_investment_types t
WHERE t.workspace_id IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- Assets (investee companies, loans, notes, fund interests, cash, ...) --------
CREATE OR REPLACE VIEW midas.fl_assets WITH (security_barrier = true) AS
SELECT
  a.id, a.workspace_id, a.name, a.canonical_name, a.legal_name, a.english_name,
  a.asset_kind, a.country, a.sector, a.sub_sector, a.instrument_terms,
  a.description, a.investment_type_id, a.created_at, a.updated_at
FROM public.fl_assets a
WHERE a.workspace_id IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- Funds (managed vehicles and external fund-of-funds targets) -----------------
CREATE OR REPLACE VIEW midas.fl_funds WITH (security_barrier = true) AS
SELECT
  f.id, f.workspace_id, f.name, f.canonical_name, f.legal_name, f.english_name,
  f.registration_no, f.managed, f.ownership_basis, f.base_currency,
  f.vintage_year, f.fund_life_years, f.status, f.mgmt_fee_rate, f.carry_rate,
  f.preferred_return_rate, f.description, f.created_at, f.updated_at
FROM public.fl_funds f
WHERE f.workspace_id IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- Positions: who (investor / fund / source of funds) holds what (fund / asset)
CREATE OR REPLACE VIEW midas.fl_positions WITH (security_barrier = true) AS
SELECT
  p.id, p.workspace_id, p.holder_investor_id, p.holder_fund_id, p.fund_id,
  p.asset_id, p.holder_source_of_fund_id, p.status, p.opened_at, p.closed_at,
  p.notes, p.created_at, p.updated_at
FROM public.fl_positions p
WHERE p.workspace_id IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- Valuations (market values) of in-scope assets, funds and positions ----------
-- fl_valuations has no workspace_id; scope it through the row it values.
CREATE OR REPLACE VIEW midas.fl_valuations WITH (security_barrier = true) AS
SELECT
  v.id, v.asset_id, v.fund_id, v.position_id, v.as_of_date, v.valuation_method,
  v.currency, v.market_value, v.price_per_unit, v.units_outstanding,
  v.gross_value, v.net_value, v.data_status, v.notes,
  v.created_at, v.updated_at
FROM public.fl_valuations v
LEFT JOIN public.fl_assets a ON a.id = v.asset_id
LEFT JOIN public.fl_funds f ON f.id = v.fund_id
LEFT JOIN public.fl_positions p ON p.id = v.position_id
WHERE COALESCE(a.workspace_id, f.workspace_id, p.workspace_id) IN (
  'd201c012-2b04-490d-a236-fbf605bcf333',
  '2e42f936-a20e-4d73-96ad-4ad4aab0c266',
  '00000000-0000-0000-0000-000000000005'
);

-- midas_reader: the Postgres user Midas logs in as. It has no password; on
-- RDS, membership in rds_iam means it can log in only with an IAM auth token
-- (terraform/rds/midas_iam_role.tf grants rds-db:connect for this user).
-- It reads the midas schema and nothing else.
--
-- Creating a role needs CREATEROLE. If the migration role doesn't have it, the
-- block below logs a NOTICE and skips; run the
-- `midas_reader_bootstrap_sql` Terraform output as the RDS master user instead.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'midas_reader') THEN
    BEGIN
      CREATE ROLE midas_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'midas: cannot CREATE ROLE midas_reader as %; run the midas_reader_bootstrap_sql Terraform output as the RDS master user', current_user;
      RETURN;
    END;
  END IF;

  -- rds_iam exists only on RDS. A local Postgres has no IAM auth, so the
  -- role stays passwordless there and nobody can log in as it.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    BEGIN
      GRANT rds_iam TO midas_reader;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'midas: cannot GRANT rds_iam TO midas_reader as %; run the midas_reader_bootstrap_sql Terraform output', current_user;
    END;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO midas_reader', current_database());
  GRANT USAGE ON SCHEMA midas TO midas_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA midas TO midas_reader;

  -- Session guards. ALTER ROLE needs CREATEROLE (or the role's owner); the
  -- bootstrap SQL sets the same values when this is skipped.
  BEGIN
    ALTER ROLE midas_reader SET search_path = midas;
    ALTER ROLE midas_reader SET default_transaction_read_only = on;
    ALTER ROLE midas_reader SET statement_timeout = '60s';
    ALTER ROLE midas_reader SET idle_in_transaction_session_timeout = '60s';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'midas: cannot ALTER ROLE midas_reader as %; run the midas_reader_bootstrap_sql Terraform output', current_user;
  END;
END
$$;
