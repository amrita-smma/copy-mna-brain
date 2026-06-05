-- Migration: Add promoted_reasons jsonb array column to companies table
-- Created: 2026-06-03

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS promoted_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN companies.promoted_reasons IS 'Append-only array of free-text promotion reasons. Mirrors dropped_reason but supports multiple entries per company.';
