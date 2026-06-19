-- Migration: Add 'discovered' to pipeline_stage enum
-- Created: 2026-06-19
-- Purpose: The relationship-graph tooling lets the agent link two companies
-- together (INVESTED_IN / PARTNER / SUPPLIER). When one side of a relationship
-- is a company we've never tracked, the agent auto-creates a companies row for
-- it so the edge has a real node to attach to. Those auto-created companies
-- don't belong in the L0–L5 deal pipeline, so they get the dedicated
-- 'discovered' stage — surfaced as its own section in Master Data.

ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'discovered';
