-- Migration: Test table to verify preview-branch migration pipeline
-- Created: 2026-04-29

CREATE TABLE IF NOT EXISTS migration_test (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
