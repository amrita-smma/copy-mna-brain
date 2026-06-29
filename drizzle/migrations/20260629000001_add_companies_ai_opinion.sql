-- Per-company AI Opinion: a firm PASS/FAIL/TENTATIVE verdict plus a brief
-- (≤50 word) rationale produced by an AI Workforce run. Surfaced as the
-- right-most "AI Opinion" column in the pipeline tables. `ai_opinion_status`
-- tracks the in-flight workforce run ('processing' | 'completed' | 'failed').
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS ai_opinion_verdict TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_status TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_updated_at TIMESTAMP WITH TIME ZONE;
