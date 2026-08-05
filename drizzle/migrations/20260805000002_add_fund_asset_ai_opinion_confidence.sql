-- Confidence + data-gap fields for Fund AI Opinion (MB-470 follow-up).
-- Lets the UI distinguish a well-supported buy/hold/sell from a thin-data
-- call, and surface the gaps the server detected at analysis time.
ALTER TABLE fund_assets
  ADD COLUMN IF NOT EXISTS ai_opinion_confidence TEXT,
  ADD COLUMN IF NOT EXISTS ai_opinion_data_gaps TEXT;
