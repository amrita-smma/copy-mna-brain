-- Fund Ledger v2 cutover: drop the legacy v1 fund_* tables.
-- The application no longer reads or writes these (all traffic goes through
-- the fl_* tables and /api/fund-ledger/*); the rollback window is over.
-- Dropped child-first so no FK forces a CASCADE. All inbound FKs to these
-- tables come from within this set (verified against prior migrations):
-- retained tables (funds, holding_entities, funding_sources, fund_updates)
-- do not reference any of them.

DROP TABLE IF EXISTS fund_asset_investor_stakes;
DROP TABLE IF EXISTS fund_asset_transactions;
DROP TABLE IF EXISTS fund_asset_valuations;
DROP TABLE IF EXISTS fund_investor_commitment_events;
DROP TABLE IF EXISTS fund_investor_stakes;
DROP TABLE IF EXISTS fund_valuations;
DROP TABLE IF EXISTS fund_assets;
