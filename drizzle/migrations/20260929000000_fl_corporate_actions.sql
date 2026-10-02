-- fl_corporate_actions
--
-- A corporate action on a company asset that changes our ownership %:
--   funding_round  a priced round; pre-money and round size are kept for audit
--                  and each position's post-round stake is computed from them
--   opening_stake  the stake a position started with (the ledger records cash,
--                  never ownership, so this is entered once per position)
--   other          any other action (share transfer, buyback, ESOP top-up…);
--                  the stake after is entered directly
-- Each of our positions in the asset gets a participation row recording its
-- stake before, any follow-on amount and its stake after. A corporate action
-- tracks ownership % only: it writes neither ledger entries nor fl_valuations
-- rows, so invested, realized and market value are all untouched.

CREATE TABLE fl_corporate_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES fl_assets(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL DEFAULT 'funding_round',
  action_date DATE NOT NULL,
  label TEXT,
  currency CHAR(3),
  pre_money NUMERIC(38, 8),
  round_size NUMERIC(38, 8),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fl_corporate_actions_action_type_check CHECK (action_type IN ('funding_round', 'opening_stake', 'other')),
  CONSTRAINT fl_corporate_actions_terms_required CHECK (
    action_type <> 'funding_round'
    OR (currency IS NOT NULL AND pre_money IS NOT NULL AND round_size IS NOT NULL)
  ),
  CONSTRAINT fl_corporate_actions_pre_money_positive CHECK (pre_money > 0),
  CONSTRAINT fl_corporate_actions_round_size_non_negative CHECK (round_size >= 0)
);

CREATE INDEX idx_fl_corporate_actions_workspace_id ON fl_corporate_actions (workspace_id);
CREATE INDEX idx_fl_corporate_actions_asset_id_action_date ON fl_corporate_actions (asset_id, action_date);

CREATE TABLE fl_ownership_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_action_id UUID NOT NULL REFERENCES fl_corporate_actions(id) ON DELETE CASCADE,
  position_id UUID NOT NULL REFERENCES fl_positions(id) ON DELETE CASCADE,
  pct_before NUMERIC(12, 8) NOT NULL,
  follow_on_amount NUMERIC(38, 8) NOT NULL DEFAULT 0,
  pct_after NUMERIC(12, 8) NOT NULL,
  pct_override NUMERIC(12, 8),
  override_remark TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fl_ownership_changes_action_position_key UNIQUE (corporate_action_id, position_id),
  CONSTRAINT fl_ownership_changes_pct_before_range CHECK (pct_before >= 0 AND pct_before <= 100),
  CONSTRAINT fl_ownership_changes_amount_non_negative CHECK (follow_on_amount >= 0),
  CONSTRAINT fl_ownership_changes_pct_override_range CHECK (pct_override IS NULL OR (pct_override >= 0 AND pct_override <= 100))
);

CREATE INDEX idx_fl_ownership_changes_corporate_action_id ON fl_ownership_changes (corporate_action_id);
CREATE INDEX idx_fl_ownership_changes_position_id ON fl_ownership_changes (position_id);
