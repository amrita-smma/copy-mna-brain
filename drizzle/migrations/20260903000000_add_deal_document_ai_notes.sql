-- add_deal_document_ai_notes
-- Adds AI-extraction fields to deal_documents so attachments get the same
-- structured-notes/tags/processing_status treatment as Smart Files.

ALTER TABLE "deal_documents" ADD COLUMN IF NOT EXISTS "raw_notes" text;
ALTER TABLE "deal_documents" ADD COLUMN IF NOT EXISTS "structured_notes" text;
ALTER TABLE "deal_documents" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}';
-- Nullable so existing attachments are not backfilled as "pending" (they will
-- never be processed). New inserts pick up the default below.
ALTER TABLE "deal_documents" ADD COLUMN IF NOT EXISTS "processing_status" text;
ALTER TABLE "deal_documents" ALTER COLUMN "processing_status" SET DEFAULT 'pending';
