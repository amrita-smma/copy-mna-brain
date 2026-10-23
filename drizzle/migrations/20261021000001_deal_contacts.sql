-- deal_contacts
-- Links CRM contacts (bankers, one person each) to the Brain deals they brought
-- (`source`) or were involved in (`involved`), per workspace. See
-- docs/features/crm-banker-insights.md#deal-links.
--
-- A row is never deleted by the app: removing or dismissing a link sets
-- status = 'dismissed', which is what stops the automatic paths (Smart Files
-- email attachments, evidence suggestions) from re-adding it.
CREATE TABLE IF NOT EXISTS deal_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  correspondent_id uuid NOT NULL REFERENCES correspondents(id) ON DELETE CASCADE,
  role text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  evidence_message_id text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_deal_contacts_workspace_company_correspondent
    UNIQUE (workspace_id, company_id, correspondent_id),
  CONSTRAINT deal_contacts_role_chk CHECK (role IN ('source', 'involved')),
  CONSTRAINT deal_contacts_origin_chk
    CHECK (origin IN ('email_attachment', 'manual', 'confirmed_suggestion')),
  CONSTRAINT deal_contacts_status_chk CHECK (status IN ('active', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_deal_contacts_workspace_correspondent
  ON deal_contacts USING btree (workspace_id, correspondent_id);

CREATE INDEX IF NOT EXISTS idx_deal_contacts_workspace_company
  ON deal_contacts USING btree (workspace_id, company_id);

-- Provenance of an email-attachment file: who sent it and on which message.
-- Only these two headers are kept (never the subject); they let the deal link
-- to the sender be resolved later when the sender's CRM contact appears after
-- the file was processed.
ALTER TABLE files ADD COLUMN IF NOT EXISTS source_sender_email text;
ALTER TABLE files ADD COLUMN IF NOT EXISTS source_message_id text;

-- Reconcile looks files up by sender address within a workspace.
CREATE INDEX IF NOT EXISTS idx_files_workspace_source_sender
  ON files USING btree (workspace_id, lower(source_sender_email))
  WHERE source_sender_email IS NOT NULL;
