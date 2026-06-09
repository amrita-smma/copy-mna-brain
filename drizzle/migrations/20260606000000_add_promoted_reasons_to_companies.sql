ALTER TABLE companies ADD COLUMN IF NOT EXISTS promoted_reasons text;
COMMENT ON COLUMN companies.promoted_reasons IS 'Free-text (markdown) block of promotion reasons. Each promotion appends its block separated by a blank line. NULL when never promoted with a reason.';
