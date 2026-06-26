-- Per-company Deal Sponsor (L0–L2) and Deal Captain (L3+). These default to
-- the matched Track's PIC for display when empty, but can be overridden per
-- company without affecting Track Settings. On promotion into L3+, Deal
-- Captain inherits Deal Sponsor when it is not already set.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS deal_sponsor TEXT,
  ADD COLUMN IF NOT EXISTS deal_captain TEXT;
