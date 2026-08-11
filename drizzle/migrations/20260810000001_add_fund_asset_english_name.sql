-- add_fund_asset_english_name
-- Original investments are often recorded under a non-English name (e.g.
-- 株式会社ABC). `english_name` holds the optional English rendering of
-- `asset_name`; the Fund Management UI shows it in brackets after the name.
ALTER TABLE fund_assets
  ADD COLUMN IF NOT EXISTS english_name TEXT;
