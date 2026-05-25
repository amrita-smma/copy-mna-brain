-- Replace legacy `contacts` / `contact_messages` with the new CRM data model
-- (employers + correspondents + emails + topics) that powers the CRM page
-- shown in the HTML mockup.

DROP TABLE IF EXISTS contact_messages;
DROP TABLE IF EXISTS contacts;

-- Role of a participant on an email (sender / recipients).
DO $$ BEGIN
  CREATE TYPE email_participant_role AS ENUM ('from', 'to', 'cc', 'bcc');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Employers — the firm (Goldman Sachs, JPM, …). One row per CRM card.
CREATE TABLE IF NOT EXISTS employers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  normalized_name TEXT UNIQUE NOT NULL,
  industry        TEXT,
  status          TEXT NOT NULL DEFAULT 'inbound',
  curation_status TEXT NOT NULL DEFAULT 'published',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employers_name        ON employers (name);
CREATE INDEX IF NOT EXISTS idx_employers_status      ON employers (status);
CREATE INDEX IF NOT EXISTS idx_employers_curation    ON employers (curation_status);

-- Correspondents — people (PICs) employed at an employer.
CREATE TABLE IF NOT EXISTS correspondents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id              UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  title                    TEXT,
  email                    TEXT,
  phone                    TEXT,
  type                     TEXT,
  is_primary               BOOLEAN NOT NULL DEFAULT false,
  source                   TEXT NOT NULL DEFAULT 'manual',
  last_edited_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  last_edited_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_correspondent_employer_email
  ON correspondents (employer_id, email) WHERE email IS NOT NULL;

-- At most one primary correspondent per employer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_correspondent_one_primary_per_employer
  ON correspondents (employer_id) WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_correspondent_email ON correspondents (email);

-- Many-to-many: a correspondent may cover several pipeline companies.
CREATE TABLE IF NOT EXISTS correspondent_companies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correspondent_id  UUID NOT NULL REFERENCES correspondents(id) ON DELETE CASCADE,
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_correspondent_companies
  ON correspondent_companies (correspondent_id, company_id);

-- Free-text notes on the employer (the "Notes" tab on the card).
CREATE TABLE IF NOT EXISTS employer_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id     UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  author_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_employer_created
  ON employer_notes (employer_id, created_at);

-- Topic dictionary (labels like "CMP slurry", "lithography", …).
CREATE TABLE IF NOT EXISTS topics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Direct topic assignments on an employer (manual + auto-derived).
CREATE TABLE IF NOT EXISTS employer_topics (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id  UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  topic_id     UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'manual',
  is_highlight BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employer_topic ON employer_topics (employer_id, topic_id);

-- Emails ingested from Vault / inbox.
CREATE TABLE IF NOT EXISTS emails (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id       UUID REFERENCES employers(id) ON DELETE SET NULL,
  from_address      TEXT NOT NULL,
  from_display_name TEXT,
  subject           TEXT,
  body_text         TEXT,
  sent_at           TIMESTAMPTZ NOT NULL,
  direction         TEXT NOT NULL,
  filter_status     TEXT NOT NULL DEFAULT 'processed',
  filter_reason     TEXT,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_employer_sent ON emails (employer_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_email_sent_at       ON emails (sent_at);

-- Per-email topic extraction.
CREATE TABLE IF NOT EXISTS email_topics (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id  UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  topic_id  UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_topic ON email_topics (email_id, topic_id);

-- One row per recipient/sender on a given email.
CREATE TABLE IF NOT EXISTS email_participants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id          UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  correspondent_id  UUID REFERENCES correspondents(id) ON DELETE SET NULL,
  address           TEXT NOT NULL,
  display_name      TEXT,
  role              email_participant_role NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_participant
  ON email_participants (email_id, address, role);
CREATE INDEX IF NOT EXISTS idx_email_participant_user
  ON email_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_email_participant_correspondent
  ON email_participants (correspondent_id);

-- Many-to-many: which internal users are working an employer.
CREATE TABLE IF NOT EXISTS employer_team_members (
  employer_id  UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employer_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_employer_team_user ON employer_team_members (user_id);

-- Permissive RLS policies (match the rest of the schema).
ALTER TABLE employers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondent_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_topics        ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_topics           ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_participants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_team_members  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'employers','correspondents','correspondent_companies','employer_notes',
    'topics','employer_topics','emails','email_topics','email_participants',
    'employer_team_members'
  ])
  LOOP
    EXECUTE format('CREATE POLICY "Allow read access on %1$s"   ON %1$s FOR SELECT TO public USING (true)',     t);
    EXECUTE format('CREATE POLICY "Allow insert access on %1$s" ON %1$s FOR INSERT TO public WITH CHECK (true)',t);
    EXECUTE format('CREATE POLICY "Allow update access on %1$s" ON %1$s FOR UPDATE TO public USING (true)',     t);
    EXECUTE format('CREATE POLICY "Allow delete access on %1$s" ON %1$s FOR DELETE TO public USING (true)',     t);
  END LOOP;
END $$;
