-- Migration: Add 'track_matching' to job_type enum
-- Purpose: When a company enters L0, a background agent job evaluates it against
-- the investment theses ("Tracks") and persists the matched track ids on the
-- company. Adding the enum value lets those job rows exist with lifecycle
-- tracking + job_logs transitions.

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'track_matching';
