-- ─── employer_domains: durable domain → employer map (resolve-once) ──────────
CREATE TABLE IF NOT EXISTS employer_domains (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'auto',          -- 'auto' | 'manual'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employer_domains_domain_key
  ON employer_domains (domain);
CREATE INDEX IF NOT EXISTS idx_employer_domains_employer
  ON employer_domains (employer_id);

-- ─── employer_overrides: curatable domain → name/industry/internal ──────────
CREATE TABLE IF NOT EXISTS employer_overrides (
  domain        TEXT PRIMARY KEY,
  employer_name TEXT,                                  -- NULL for excluded-only rows
  industry      TEXT,
  internal      BOOLEAN NOT NULL DEFAULT false,
  excluded      BOOLEAN NOT NULL DEFAULT false,        -- dropped from ingest (was domains.json `_excluded`)
  edited_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── employer_curation: human overlay for employer machine fields ───────────
CREATE TABLE IF NOT EXISTS employer_curation (
  employer_id UUID PRIMARY KEY REFERENCES employers(id) ON DELETE CASCADE,
  name        TEXT,                                  -- NULL = use employers.name
  industry    TEXT,                                  -- NULL = use employers.industry
  edited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── correspondent_curation: human overlay (NO is_primary — base-only) ──────
CREATE TABLE IF NOT EXISTS correspondent_curation (
  correspondent_id UUID PRIMARY KEY REFERENCES correspondents(id) ON DELETE CASCADE,
  name             TEXT,
  title            TEXT,
  phone            TEXT,
  type             TEXT,
  edited_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── correspondents.origin ──────────────────────────────────────────────────
ALTER TABLE correspondents
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'auto';

-- Existing human-added contacts (source='manual') must be invisible to the
-- ETL, which only ever touches origin='auto'. Auto-discovered rows (source
-- 'mbox'/'auto') stay 'auto'.
UPDATE correspondents SET origin = 'manual' WHERE source = 'manual';

-- ─── permissive RLS (matches the rest of the schema) ────────────────────────
ALTER TABLE employer_domains        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_overrides      ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_curation       ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondent_curation  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'employer_domains','employer_overrides','employer_curation',
    'correspondent_curation'
  ])
  LOOP
    EXECUTE format('CREATE POLICY "Allow read access on %1$s"   ON %1$s FOR SELECT TO public USING (true)',     t);
    EXECUTE format('CREATE POLICY "Allow insert access on %1$s" ON %1$s FOR INSERT TO public WITH CHECK (true)',t);
    EXECUTE format('CREATE POLICY "Allow update access on %1$s" ON %1$s FOR UPDATE TO public USING (true)',     t);
    EXECUTE format('CREATE POLICY "Allow delete access on %1$s" ON %1$s FOR DELETE TO public USING (true)',     t);
  END LOOP;
END $$;
