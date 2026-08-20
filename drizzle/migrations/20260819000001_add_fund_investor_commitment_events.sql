-- MB-492: Add fund_investor_commitment_events table and backfill opening events from existing stakes

CREATE TYPE commitment_event_type AS ENUM (
  'initial_commitment',
  'additional_commitment',
  'reduction',
  'transfer_in',
  'transfer_out'
);

CREATE TABLE fund_investor_commitment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  holding_entity_id UUID NOT NULL REFERENCES holding_entities(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  event_type commitment_event_type NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  counterparty_holding_entity_id UUID REFERENCES holding_entities(id) ON DELETE SET NULL,
  transfer_group_id UUID,
  notes TEXT,
  source TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fund_commitment_events_amount_positive CHECK (amount > 0)
);

CREATE INDEX idx_fund_commitment_events_fund_holding_entity ON fund_investor_commitment_events (fund_id, holding_entity_id);
CREATE INDEX idx_fund_commitment_events_transfer_group ON fund_investor_commitment_events (transfer_group_id);

CREATE TRIGGER update_fund_investor_commitment_events_updated_at
  BEFORE UPDATE ON fund_investor_commitment_events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Backfill: create one opening/initial commitment event for every existing non-null commitment stake
INSERT INTO fund_investor_commitment_events (
  id,
  fund_id,
  holding_entity_id,
  effective_date,
  event_type,
  amount,
  currency,
  notes,
  source,
  created_by,
  updated_by,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  s.fund_id,
  s.holding_entity_id,
  COALESCE(s.created_at::date, CURRENT_DATE),
  'initial_commitment'::commitment_event_type,
  s.commitment_amount,
  COALESCE(s.commitment_amount_currency, 'USD'),
  'Migrated initial commitment',
  'legacy_migration',
  s.created_by,
  s.updated_by,
  COALESCE(s.created_at, now()),
  COALESCE(s.updated_at, now())
FROM fund_investor_stakes s
WHERE s.commitment_amount IS NOT NULL
  AND s.commitment_amount > 0
  AND s.holding_entity_id IS NOT NULL;
