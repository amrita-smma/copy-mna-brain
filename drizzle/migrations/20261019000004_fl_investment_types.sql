-- Investment types: a workspace-configurable grouping for fund-ledger assets
-- ("by investment type" in Fund Management). Each asset may be assigned to at
-- most one type; deleting a type unassigns its assets.
CREATE TABLE IF NOT EXISTS fl_investment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fl_investment_types_workspace_id
  ON fl_investment_types USING btree (workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS fl_investment_types_workspace_name_uniq
  ON fl_investment_types (workspace_id, lower(name));

ALTER TABLE fl_assets
  ADD COLUMN IF NOT EXISTS investment_type_id uuid
  REFERENCES fl_investment_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fl_assets_investment_type_id
  ON fl_assets USING btree (investment_type_id);

-- Give every existing workspace the default set of investment types.
INSERT INTO fl_investment_types (workspace_id, name, sort_order)
SELECT w.id, d.name, d.sort_order
FROM workspaces w
CROSS JOIN (VALUES
  ('Realized Funds', 0),
  ('Venture Capital', 1),
  ('Private Equity', 2),
  ('Private Credit', 3),
  ('Others', 4),
  ('Realized and Partially Realized', 5),
  ('Unrealized', 6)
) AS d(name, sort_order)
ON CONFLICT DO NOTHING;
