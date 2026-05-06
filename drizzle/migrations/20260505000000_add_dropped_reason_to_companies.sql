-- Migration: Add dropped_reason + dropped_at columns to companies table
-- Created: 2026-05-05

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS dropped_reason text,
  ADD COLUMN IF NOT EXISTS dropped_at timestamptz;

COMMENT ON COLUMN companies.dropped_reason IS 'Free-text reason captured when a deal is dropped. Cleared on restore.';
COMMENT ON COLUMN companies.dropped_at IS 'Timestamp when the deal was dropped. Cleared on restore.';
