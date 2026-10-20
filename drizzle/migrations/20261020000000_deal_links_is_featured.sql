-- deal_links_is_featured
--
-- Lets a YouTube link be a company's Featured Slide, alongside the PDF / PPTX /
-- video / audio uploads that already can be (deal_documents.is_featured). The
-- partial unique index keeps at most one featured link per deal; the services
-- clear the other table's flag so a deal has one featured item overall.
ALTER TABLE "deal_links" ADD COLUMN IF NOT EXISTS "is_featured" boolean DEFAULT false NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_links_one_featured" ON "deal_links" USING btree ("deal_id") WHERE is_featured = true;
