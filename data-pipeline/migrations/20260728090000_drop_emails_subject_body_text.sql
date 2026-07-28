-- MB-473: Drop durable email subject/body from analytics.emails.
-- Bodies were already scrubbed (ephemeral pipeline phase0); subjects are no
-- longer needed as CRM facts. In-memory/parser subject remains for LLM only.

SET search_path = analytics, public;

ALTER TABLE analytics.emails
  DROP COLUMN IF EXISTS subject,
  DROP COLUMN IF EXISTS body_text;
