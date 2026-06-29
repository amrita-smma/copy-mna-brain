-- add_track_variables
-- Per-Track custom variable definitions (track_variables) plus a per-company
-- JSONB store (companies.track_specific_variables) keyed by track_id then
-- variable_id. Variable definitions apply to every company matched to a Track;
-- each company holds its own values.

CREATE TABLE IF NOT EXISTS track_variables (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The Track (investment_thesis) this variable belongs to.
  track_id UUID NOT NULL REFERENCES investment_thesis(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Display unit, e.g. percentage, tonne, currency. Free-text.
  unit TEXT,
  -- How the value is captured on the Company Card: 'textbox' | 'radio'.
  type TEXT NOT NULL DEFAULT 'textbox',
  -- Choices for 'radio' type variables (ignored for 'textbox').
  options JSONB DEFAULT '[]'::jsonb,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_track_variables_track_id ON track_variables(track_id);

CREATE TRIGGER update_track_variables_updated_at
  BEFORE UPDATE ON track_variables
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Per-company values for the track variables, nested by track_id:
-- { "<track_id>": { "<variable_id>": "<value>" } }
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS track_specific_variables JSONB DEFAULT '{}'::jsonb;
