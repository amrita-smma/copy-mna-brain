-- A fund investor stake requires a fund, but its investment entity and funding
-- source are optional. The base (20260708000003) added funding_source_id
-- NOT NULL, and investor_id was NOT NULL from the original fund-management
-- migration; relax both so a stake can be recorded against a fund alone.
ALTER TABLE fund_investor_stakes ALTER COLUMN investor_id DROP NOT NULL;
ALTER TABLE fund_investor_stakes ALTER COLUMN funding_source_id DROP NOT NULL;
