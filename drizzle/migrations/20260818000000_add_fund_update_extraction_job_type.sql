-- Migration: Add 'fund_update_extraction' to job_type enum
-- Purpose: Asynchronous extraction for Fund Updates workbooks (Smart Files LLM fallback)

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'fund_update_extraction';
