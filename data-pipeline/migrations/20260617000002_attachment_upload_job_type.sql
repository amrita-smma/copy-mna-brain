-- MB-214: add attachment_upload job type for AFD integration
ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'attachment_upload';
