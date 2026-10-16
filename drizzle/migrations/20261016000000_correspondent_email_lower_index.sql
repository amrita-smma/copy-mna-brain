-- correspondent_email_lower_index
-- Email is the join key between manually-added CRM contacts and contacts
-- ingested from email, matched case-insensitively and across employers
-- (CorrespondentRepository.findByEmails, used by createContact, the CSV
-- contact import and the ingest paths). A `lower(email) IN (...)` predicate
-- cannot use the plain `idx_correspondent_email` btree, so index the expression.
CREATE INDEX IF NOT EXISTS "idx_correspondent_email_lower"
  ON "correspondents" USING btree (lower("email"));
