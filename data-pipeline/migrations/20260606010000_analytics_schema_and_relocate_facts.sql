CREATE SCHEMA IF NOT EXISTS analytics;
--> statement-breakpoint
ALTER TABLE emails ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails (in_reply_to);
--> statement-breakpoint
ALTER TABLE emails             SET SCHEMA analytics;
--> statement-breakpoint
ALTER TABLE email_participants SET SCHEMA analytics;
--> statement-breakpoint
ALTER TABLE email_topics       SET SCHEMA analytics;
