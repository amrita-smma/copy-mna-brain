-- MB-214: add origin_email boolean to files for pipeline-sourced attachment tracking
ALTER TABLE files ADD COLUMN IF NOT EXISTS origin_email BOOLEAN NOT NULL DEFAULT FALSE;
