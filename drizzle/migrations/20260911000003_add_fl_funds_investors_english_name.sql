-- add_fl_funds_investors_english_name
-- Add nullable english_name to fl_funds and fl_investors for bilingual English name support.
ALTER TABLE fl_funds
  ADD COLUMN IF NOT EXISTS english_name TEXT;

ALTER TABLE fl_investors
  ADD COLUMN IF NOT EXISTS english_name TEXT;
