-- fund_ledger_event_revisions

CREATE TABLE fl_business_event_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_event_id UUID NOT NULL REFERENCES fl_business_events(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (business_event_id, revision_no)
);

CREATE INDEX idx_fl_business_event_revisions_workspace_id ON fl_business_event_revisions (workspace_id);
CREATE INDEX idx_fl_business_event_revisions_business_event_id ON fl_business_event_revisions (business_event_id);
