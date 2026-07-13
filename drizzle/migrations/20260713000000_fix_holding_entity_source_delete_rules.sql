-- fix_holding_entity_source_delete_rules
--
-- 20260712000006_refactor_funds_architecture re-created these FKs with
-- ON DELETE NO ACTION, regressing the original ON DELETE CASCADE from
-- 20260712000001 and diverging from schema.ts (which declares cascade / set
-- null). The NO ACTION rule makes deleting a holding_entity or funding_source
-- fail whenever any stake or transaction still references it. Bring the DB
-- back in line with the intended behavior:
--   * stakes           -> CASCADE  (a stake has no meaning without its entity/source)
--   * transactions     -> SET NULL (ledger rows survive, just become unattributed)
--
-- The same NO ACTION regression hit fund_asset_transactions.fund_id, which we
-- also restore to SET NULL so deleting a fund detaches (rather than deletes or
-- blocks) its transactions.

-- Stakes reference the investment entity -> cascade so the pledge rows go with it.
ALTER TABLE "fund_investor_stakes" DROP CONSTRAINT IF EXISTS "fund_investor_stakes_holding_entity_id_fkey";
ALTER TABLE "fund_investor_stakes" ADD CONSTRAINT "fund_investor_stakes_holding_entity_id_fkey" FOREIGN KEY ("holding_entity_id") REFERENCES "holding_entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "fund_asset_investor_stakes" DROP CONSTRAINT IF EXISTS "fund_asset_investor_stakes_holding_entity_id_fkey";
ALTER TABLE "fund_asset_investor_stakes" ADD CONSTRAINT "fund_asset_investor_stakes_holding_entity_id_fkey" FOREIGN KEY ("holding_entity_id") REFERENCES "holding_entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Transactions reference the entity/source only as attribution -> set null so
-- the underlying ledger (and therefore each holding's metrics) is preserved.
ALTER TABLE "fund_asset_transactions" DROP CONSTRAINT IF EXISTS "fund_asset_transactions_holding_entity_id_fkey";
ALTER TABLE "fund_asset_transactions" ADD CONSTRAINT "fund_asset_transactions_holding_entity_id_fkey" FOREIGN KEY ("holding_entity_id") REFERENCES "holding_entities"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "fund_asset_transactions" DROP CONSTRAINT IF EXISTS "fund_asset_transactions_funding_source_id_fkey";
ALTER TABLE "fund_asset_transactions" ADD CONSTRAINT "fund_asset_transactions_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- Deleting a fund must NOT delete the ledger either. A transaction's fund_id is
-- just its fund attribution (assets carry no fund_id post-refactor), so set null
-- on fund delete: the transactions/holdings survive and fall into "Unassigned
-- Assets". Only deleting the ASSET cascade-deletes its transactions
-- (fund_asset_transactions.fund_asset_id -> fund_assets stays ON DELETE CASCADE).
-- schema.ts already declared this as set null; the DB was left on NO ACTION by
-- 20260712000006.
ALTER TABLE "fund_asset_transactions" DROP CONSTRAINT IF EXISTS "fund_asset_transactions_fund_id_fkey";
ALTER TABLE "fund_asset_transactions" ADD CONSTRAINT "fund_asset_transactions_fund_id_fkey" FOREIGN KEY ("fund_id") REFERENCES "funds"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
