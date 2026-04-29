-- Migration: Add ebitda_local to company_fx_adjustments for symmetric FX-based USD backfill
-- Created: 2026-04-28

ALTER TABLE company_fx_adjustments
  ADD COLUMN IF NOT EXISTS ebitda_local NUMERIC;
