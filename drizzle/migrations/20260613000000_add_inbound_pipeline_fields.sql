-- Enum for deal_type (HTML-parity pipeline fields, inbound first). Safe if present.
DO $$ BEGIN
    CREATE TYPE deal_type AS ENUM ('majority', 'minority');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- New companies columns. All additive/nullable — non-destructive, no backfill.
-- doc_type is plain text: its values are constrained in the app UI, not the DB.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deal_type deal_type DEFAULT 'majority';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS originator text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS banker text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stake text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deal_size text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS workflow_status text;

COMMENT ON COLUMN companies.workflow_status IS 'Free-text pipeline workflow status (inbound or outbound — disambiguated by companies.source). Saved values are surfaced as reusable dropdown options on the FE; intentionally not an enum.';
