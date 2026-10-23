-- email_notes

SET search_path = analytics, public;

CREATE TABLE IF NOT EXISTS analytics.email_notes (
  email_id uuid PRIMARY KEY REFERENCES analytics.emails(id) ON DELETE CASCADE,
  -- NULL = the model judged the email to have no business substance. The row
  -- still exists so the backfill never re-asks the model about this email.
  summary text,
  key_points jsonb NOT NULL DEFAULT '[]'::jsonb,   -- string[], at most 4
  next_step text,
  next_step_status text NOT NULL DEFAULT 'none'
    CHECK (next_step_status IN ('action', 'done', 'none')),
  sentiment text NOT NULL DEFAULT 'neutral'
    CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.email_role_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES analytics.emails(id) ON DELETE CASCADE,
  address text NOT NULL,          -- lower-cased EXTERNAL participant address
  label text NOT NULL
    CHECK (label IN (
      'funding', 'lending', 'finance', 'tax', 'advisory', 'legal',
      'due_diligence', 'principal', 'other'
    )),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  evidence text NOT NULL,         -- one-sentence paraphrase, never a verbatim quote
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_id, address, label)
);

CREATE INDEX IF NOT EXISTS idx_email_role_signals_address
  ON analytics.email_role_signals (lower(address));
