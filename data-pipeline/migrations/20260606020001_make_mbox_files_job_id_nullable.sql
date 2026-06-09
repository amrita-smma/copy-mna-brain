-- Make analytics.mbox_files.job_id nullable to support Lambda insertions
-- that do not have a Vercel job context.
ALTER TABLE analytics.mbox_files ALTER COLUMN job_id DROP NOT NULL;
