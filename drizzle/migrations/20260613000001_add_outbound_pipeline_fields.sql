-- Outbound pipeline (HTML-parity) field. Additive/nullable — non-destructive.
-- Financials roll-up (Revenue/EBITDA/EV) is composed on the FE from
-- company_financials, so no free-text financial_info column is stored.
-- Workflow status is shared with inbound via companies.workflow_status.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS key_rationale text;

COMMENT ON COLUMN companies.key_rationale IS 'Outbound investment rationale (free text).';
