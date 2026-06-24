-- [MB-260] add recent_files table backing the Presentation page's
-- recently-opened files list. One row per (user, file) — re-opening a file
-- bumps opened_at instead of inserting a duplicate.

CREATE TABLE IF NOT EXISTS recent_files (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL,
  file_name text NOT NULL,
  file_key text NOT NULL,
  opened_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT recent_files_user_id_file_key_key UNIQUE (user_id, file_key)
);

DO $$ BEGIN
  ALTER TABLE recent_files
    ADD CONSTRAINT recent_files_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_recent_files_user_opened
  ON recent_files USING btree (user_id, opened_at DESC);
