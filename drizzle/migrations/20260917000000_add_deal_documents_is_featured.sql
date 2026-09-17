-- add_deal_documents_is_featured
--
-- Lets a company feature a single PDF/PPTX one-pager (the "Featured Slide")
-- alongside its AI Company Card. `is_featured` marks that document; the
-- partial unique index guarantees at most one per deal — uploading a new
-- featured slide replaces (deletes) the previous one before insert, this is
-- the DB-level backstop against a race between two uploads.
ALTER TABLE "deal_documents" ADD COLUMN IF NOT EXISTS "is_featured" boolean DEFAULT false NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_documents_one_featured" ON "deal_documents" USING btree ("deal_id") WHERE is_featured = true;
