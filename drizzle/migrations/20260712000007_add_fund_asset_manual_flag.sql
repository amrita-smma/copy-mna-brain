-- add_fund_asset_manual_flag
ALTER TABLE "fund_assets" ADD COLUMN "is_manually_overridden" boolean DEFAULT false NOT NULL;
