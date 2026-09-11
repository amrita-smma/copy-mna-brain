-- add_cash_movement_pairing_and_system_cash_uniq
ALTER TABLE fl_ledger_entries
  ADD COLUMN source_ledger_entry_id uuid REFERENCES fl_ledger_entries(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX fl_ledger_entries_source_position_uniq
  ON fl_ledger_entries (source_ledger_entry_id, position_id)
  WHERE source_ledger_entry_id IS NOT NULL;

CREATE UNIQUE INDEX fl_assets_system_cash_currency_uniq
  ON fl_assets (workspace_id, (instrument_terms->>'currency'))
  WHERE asset_kind = 'cash' AND instrument_terms->>'system_cash' = 'true';
