-- add_fund_update_extraction_job_type
ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'fund_update_extraction';
