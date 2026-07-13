-- Add funding_sources_table
-- Spec update for Fund Management (Confluence 2641362965)
-- Link fund_investor_stakes and fund_asset_investor_stakes to funding_sources

CREATE TABLE funding_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT funding_sources_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT funding_sources_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_funding_sources_workspace_id ON funding_sources (workspace_id);

CREATE TRIGGER update_funding_sources_updated_at
  BEFORE UPDATE ON funding_sources
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Update fund_investor_stakes
ALTER TABLE fund_investor_stakes
  DROP CONSTRAINT fund_investor_stakes_fund_investor_uniq;

ALTER TABLE fund_investor_stakes
  ADD COLUMN funding_source_id UUID NOT NULL;

ALTER TABLE fund_investor_stakes
  ADD CONSTRAINT fund_investor_stakes_funding_source_id_fkey FOREIGN KEY (funding_source_id) REFERENCES funding_sources(id) ON DELETE CASCADE,
  ADD CONSTRAINT fund_investor_stakes_fund_investor_uniq UNIQUE (fund_id, investor_id, funding_source_id);

-- Update fund_asset_investor_stakes
ALTER TABLE fund_asset_investor_stakes
  DROP CONSTRAINT fund_asset_investor_stakes_asset_investor_uniq;

ALTER TABLE fund_asset_investor_stakes
  ADD COLUMN funding_source_id UUID NOT NULL;

ALTER TABLE fund_asset_investor_stakes
  ADD CONSTRAINT fund_asset_investor_stakes_funding_source_id_fkey FOREIGN KEY (funding_source_id) REFERENCES funding_sources(id) ON DELETE CASCADE,
  ADD CONSTRAINT fund_asset_investor_stakes_asset_investor_uniq UNIQUE (fund_asset_id, investor_id, funding_source_id);
