-- add_deal_document_processing_job_type
-- Purpose: Asynchronous AI extraction for deal-document (Attachments) uploads.

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'deal_document_processing';
