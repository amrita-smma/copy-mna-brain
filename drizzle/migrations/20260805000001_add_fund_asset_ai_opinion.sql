-- Per-holding AI Opinion: a firm BUY/HOLD/SELL verdict plus a brief
-- (≤50 word) rationale produced by an AI Workforce run. Surfaced as the
-- right-most "AI Opinion" column in the Fund Management Asset table.
-- `ai_opinion_status` tracks the in-flight workforce run
-- ('processing' | 'completed' | 'failed').
ALTER TABLE fund_assets
  ADD COLUMN IF NOT EXISTS ai_opinion_verdict TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_status TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_updated_at TIMESTAMP WITH TIME ZONE;
