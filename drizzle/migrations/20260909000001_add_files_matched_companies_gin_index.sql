-- `files.matched_companies @> '[{"id": ...}]'` is now on the Company Card
-- generation path (FileRepository.findByMatchedCompanyId), in addition to the
-- existing company-detail read. A jsonb containment predicate cannot use the
-- workspace btree index, so without this it is a sequential scan of files on
-- every card run.
CREATE INDEX IF NOT EXISTS "idx_files_matched_companies_gin"
  ON "files" USING gin ("matched_companies" jsonb_path_ops);
