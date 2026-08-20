-- MB-493: Link retained divestment proceeds to fund cash ledger (Schema)
-- Adds internal_transfer to transaction_type enum, adds source_divestment_txn_id
-- foreign key and unique constraint on fund_asset_transactions.

-- 1. Add internal_transfer to transaction_type enum
DO $$ BEGIN
  ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'internal_transfer';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Add source_divestment_txn_id column to fund_asset_transactions
ALTER TABLE fund_asset_transactions
  ADD COLUMN IF NOT EXISTS source_divestment_txn_id UUID;

-- 3. Add foreign key and unique constraint
DO $$ BEGIN
  ALTER TABLE fund_asset_transactions
    ADD CONSTRAINT fund_asset_transactions_source_divestment_fkey
    FOREIGN KEY (source_divestment_txn_id)
    REFERENCES fund_asset_transactions(id)
    ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE fund_asset_transactions
    ADD CONSTRAINT fund_asset_transactions_source_divestment_uniq
    UNIQUE (source_divestment_txn_id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
