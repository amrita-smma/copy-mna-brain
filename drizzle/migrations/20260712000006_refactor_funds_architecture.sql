-- refactor_funds_architecture

-- Rename investors to holding_entities
ALTER TABLE "investors" RENAME TO "holding_entities";

-- Add relation fields to fund_asset_transactions up front so we can backfill
-- fund_id from fund_assets.fund_id before that column is dropped below.
ALTER TABLE "fund_asset_transactions" ADD COLUMN "fund_id" uuid;
ALTER TABLE "fund_asset_transactions" ADD COLUMN "holding_entity_id" uuid;
ALTER TABLE "fund_asset_transactions" ADD COLUMN "funding_source_id" uuid;

-- Add workspace_id to fund_assets (nullable first, backfilled below).
ALTER TABLE "fund_assets" ADD COLUMN "workspace_id" uuid;

-- Backfill workspace_id from the owning fund rather than an arbitrary
-- workspaces row, so multi-tenant databases keep correct tenant isolation.
-- fund_assets.fund_id was NOT NULL with an FK to funds, so every existing
-- asset resolves to exactly one workspace here.
UPDATE "fund_assets" AS fa
  SET "workspace_id" = f."workspace_id"
  FROM "funds" AS f
  WHERE fa."fund_id" = f."id";

-- Preserve each transaction's fund association before we drop
-- fund_assets.fund_id, so assets/transactions don't become "unassigned".
UPDATE "fund_asset_transactions" AS t
  SET "fund_id" = fa."fund_id"
  FROM "fund_assets" AS fa
  WHERE t."fund_asset_id" = fa."id";

-- Now that workspace_id is fully populated, enforce NOT NULL + FK + index.
ALTER TABLE "fund_assets" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "fund_assets" ADD CONSTRAINT "fund_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX IF NOT EXISTS "idx_fund_assets_workspace_id" ON "fund_assets" USING btree ("workspace_id" uuid_ops);

-- Drop fund_id from fund_assets (moved onto fund_asset_transactions above).
ALTER TABLE "fund_assets" DROP CONSTRAINT "fund_assets_fund_id_fkey";
ALTER TABLE "fund_assets" DROP COLUMN "fund_id";

-- Wire up FKs for the new fund_asset_transactions relation columns.
ALTER TABLE "fund_asset_transactions" ADD CONSTRAINT "fund_asset_transactions_fund_id_fkey" FOREIGN KEY ("fund_id") REFERENCES "funds"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "fund_asset_transactions" ADD CONSTRAINT "fund_asset_transactions_holding_entity_id_fkey" FOREIGN KEY ("holding_entity_id") REFERENCES "holding_entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "fund_asset_transactions" ADD CONSTRAINT "fund_asset_transactions_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Rename constraints and columns in stake tables
ALTER TABLE "fund_investor_stakes" RENAME COLUMN "investor_id" TO "holding_entity_id";
ALTER TABLE "fund_asset_investor_stakes" RENAME COLUMN "investor_id" TO "holding_entity_id";

ALTER TABLE "fund_investor_stakes" DROP CONSTRAINT "fund_investor_stakes_investor_id_fkey";
ALTER TABLE "fund_investor_stakes" ADD CONSTRAINT "fund_investor_stakes_holding_entity_id_fkey" FOREIGN KEY ("holding_entity_id") REFERENCES "holding_entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "fund_asset_investor_stakes" DROP CONSTRAINT "fund_asset_investor_stakes_investor_id_fkey";
ALTER TABLE "fund_asset_investor_stakes" ADD CONSTRAINT "fund_asset_investor_stakes_holding_entity_id_fkey" FOREIGN KEY ("holding_entity_id") REFERENCES "holding_entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
