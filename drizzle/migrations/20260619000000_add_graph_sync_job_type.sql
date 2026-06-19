-- Migration: Add 'graph_sync' to job_type enum
-- Created: 2026-06-19
-- Purpose: The "sync with database" endpoint for the relationship graph
-- dispatches a background job that reconciles the Neo4j graph against Postgres
-- (the source of truth). Adding the enum value lets those job rows exist and
-- get lifecycle tracking + job_logs transitions for free.

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'graph_sync';
