-- Free-text action items tracked per asset on the Fund Management asset table.
ALTER TABLE fl_assets ADD COLUMN IF NOT EXISTS action_items text;
