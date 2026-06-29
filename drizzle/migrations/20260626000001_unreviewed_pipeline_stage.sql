-- [MB-343] Add 'unreviewed' pipeline stage.
-- Uses CREATE TYPE instead of ALTER TYPE ADD VALUE so this works inside a
-- single Drizzle migration transaction (Postgres forbids using a newly-added
-- enum value in the same transaction that added it via ADD VALUE).

-- 1. Rename the existing enum and create a new one that includes 'unreviewed'.
ALTER TYPE pipeline_stage RENAME TO pipeline_stage_old;
CREATE TYPE pipeline_stage AS ENUM (
  'market_screening', 'unreviewed', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'discovered'
);

-- 2. Migrate the column to the new type, resetting the default.
ALTER TABLE companies ALTER COLUMN pipeline_stage DROP DEFAULT;
ALTER TABLE companies
  ALTER COLUMN pipeline_stage TYPE pipeline_stage
  USING pipeline_stage::text::pipeline_stage;
ALTER TABLE companies ALTER COLUMN pipeline_stage SET DEFAULT 'L0';

-- 3. Convert existing unreviewed-L0 rows to the new stage.
UPDATE companies
SET pipeline_stage = 'unreviewed'
WHERE pipeline_stage = 'L0' AND review_state = 'unreviewed';

-- 4. Add an audit log entry for every converted company.
INSERT INTO company_logs (company_id, action)
SELECT id, 'MIGRATED_TO_UNREVIEWED_STAGE'
FROM companies
WHERE pipeline_stage = 'unreviewed';

-- 5. Drop the review_state column and its index.
DROP INDEX IF EXISTS idx_companies_review_state;
ALTER TABLE companies DROP COLUMN IF EXISTS review_state;

-- 6. Drop the old enum.
DROP TYPE pipeline_stage_old;
