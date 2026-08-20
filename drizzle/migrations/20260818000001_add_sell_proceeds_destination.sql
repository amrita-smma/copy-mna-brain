-- MB-493: Audited sell proceeds destination for fund asset transactions.
-- Divestments track whether realized proceeds return to the fund's cash reserves
-- ('cash_in_fund') or are distributed to LPs/investors ('distributed_to_investor').
-- Non-divestment transactions must have NULL for sell_proceeds_destination.

-- 1. Create enum type for sell proceeds destination
DO $$ BEGIN
  CREATE TYPE sell_proceeds_destination AS ENUM ('cash_in_fund', 'distributed_to_investor');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Add nullable column to fund_asset_transactions
ALTER TABLE fund_asset_transactions
  ADD COLUMN IF NOT EXISTS sell_proceeds_destination sell_proceeds_destination;

-- 3. Backfill every existing divestment to distributed_to_investor
UPDATE fund_asset_transactions
  SET sell_proceeds_destination = 'distributed_to_investor'
  WHERE txn_type = 'divestment';

-- 4. Add CHECK invariant: require destination exactly for divestment and NULL for every non-divestment
DO $$ BEGIN
  ALTER TABLE fund_asset_transactions
    ADD CONSTRAINT fund_asset_transactions_sell_proceeds_destination_chk
    CHECK (
      (txn_type = 'divestment' AND sell_proceeds_destination IS NOT NULL)
      OR
      (txn_type != 'divestment' AND sell_proceeds_destination IS NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
