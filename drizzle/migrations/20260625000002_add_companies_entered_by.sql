-- Records who entered a company into the pipeline: the literal
-- "AI Email Scanning" for companies auto-created from banker email
-- attachments, or the name of the person who manually enters/uploads.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS entered_by TEXT;
