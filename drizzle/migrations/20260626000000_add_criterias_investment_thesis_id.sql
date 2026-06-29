-- A screening criterion belongs to exactly one Track (investment_thesis).
ALTER TABLE criterias ADD COLUMN IF NOT EXISTS investment_thesis_id uuid;

DO $$ BEGIN
  ALTER TABLE criterias
    ADD CONSTRAINT criterias_investment_thesis_id_fkey
    FOREIGN KEY (investment_thesis_id) REFERENCES investment_thesis(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_criterias_investment_thesis_id
  ON criterias USING btree (investment_thesis_id);
