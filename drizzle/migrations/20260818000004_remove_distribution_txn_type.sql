-- Fold 'distribution' transaction type into 'divestment' with sell_proceeds_destination = 'distributed_to_investor'.
-- Setting both columns together ensures compliance with fund_asset_transactions_sell_proceeds_destination_chk.
UPDATE fund_asset_transactions
SET txn_type = 'divestment',
    sell_proceeds_destination = 'distributed_to_investor'
WHERE txn_type = 'distribution';
