-- add_valuation_delta_to_fl_ledger_entries
ALTER TABLE fl_ledger_entries ADD COLUMN valuation_delta NUMERIC(38,8) NOT NULL DEFAULT 0;
