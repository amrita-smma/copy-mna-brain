-- Per-company manual matches to investment_thesis ("Track") rows.
-- Empty array → the UI falls back to auto-suggested tracks.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS matched_track_ids JSONB DEFAULT '[]'::jsonb;
