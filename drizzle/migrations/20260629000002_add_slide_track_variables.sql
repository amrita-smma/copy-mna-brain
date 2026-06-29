-- add_slide_track_variables
-- Per-company selection of which Track variables are surfaced on the Company
-- Card slide deck (under "Indicative Financials"). Holds an array of
-- track_variables.id values; an empty array means none are shown.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS slide_track_variable_ids JSONB DEFAULT '[]'::jsonb;
