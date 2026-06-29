-- Per-track AI screening. A screening row now belongs to a
-- (company, track, criterion) triple, so a company matched to N tracks produces
-- N independent screening groups in the progress panel. `track_id` references
-- the investment_thesis ("Track"); legacy rows keep a NULL track_id.
ALTER TABLE screenings ADD COLUMN IF NOT EXISTS track_id uuid;

DO $$ BEGIN
  ALTER TABLE screenings
    ADD CONSTRAINT screenings_track_id_fkey
    FOREIGN KEY (track_id) REFERENCES investment_thesis(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_screenings_track_id
  ON screenings USING btree (track_id);

-- Replace the (company_id, criteria_id) uniqueness with one that includes the
-- track, so the same criterion can run under different tracks for one company.
ALTER TABLE screenings DROP CONSTRAINT IF EXISTS screenings_company_id_criteria_id_key;

DO $$ BEGIN
  ALTER TABLE screenings
    ADD CONSTRAINT screenings_company_track_criteria_key
    UNIQUE (company_id, track_id, criteria_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
