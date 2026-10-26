-- Firm industry auto-classification: an hourly cron labels firms whose
-- industry is still empty, through a job of this type.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'firm_industry_classification';

-- When the classifier last picked this firm up. Set on claim, whatever the
-- model answers, so a firm it cannot place is not re-sent every hour.
ALTER TABLE employers ADD COLUMN IF NOT EXISTS industry_classified_at timestamptz;
