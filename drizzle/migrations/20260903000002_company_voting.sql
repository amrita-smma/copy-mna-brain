-- Migration: Company voting system
-- Purpose: Investment-Committee style vote on a single company. One
--          `company_vote_sessions` row per round, one `company_vote_ballots`
--          row per selected voter. Also registers the `company_vote` job type
--          used by the notification / conclusion background jobs.

DO $$ BEGIN
  CREATE TYPE "vote_session_status" AS ENUM ('active', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "vote_choice" AS ENUM ('hard_yes', 'yes', 'no', 'inconclusive', 'hard_no');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "vote_ballot_status" AS ENUM ('draft', 'submitted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'company_vote';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_vote_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"initiated_by" uuid NOT NULL,
	"status" "vote_session_status" DEFAULT 'active' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"duration_days" integer DEFAULT 0 NOT NULL,
	"duration_hours" integer DEFAULT 0 NOT NULL,
	"concluded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"ai_status" "analysis_job_status" DEFAULT 'pending' NOT NULL,
	"ai_synthesis" text,
	"ai_key_positives" jsonb,
	"ai_key_concerns" jsonb,
	"ai_opinion_verdict" text,
	"ai_opinion_summary" text,
	"ai_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_vote_ballots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vote_session_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"choice" "vote_choice",
	"body_html" text,
	"status" "vote_ballot_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"auto_submitted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_vote_ballots_session_voter_key" UNIQUE("vote_session_id","voter_id")
);
--> statement-breakpoint
ALTER TABLE "company_vote_sessions" ADD CONSTRAINT "company_vote_sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_vote_sessions" ADD CONSTRAINT "company_vote_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- RESTRICT, not cascade: deleting a user must never silently delete a
-- concluded round (initiator) or rewrite its tally (voter).
ALTER TABLE "company_vote_sessions" ADD CONSTRAINT "company_vote_sessions_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_vote_ballots" ADD CONSTRAINT "company_vote_ballots_vote_session_id_fkey" FOREIGN KEY ("vote_session_id") REFERENCES "public"."company_vote_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_vote_ballots" ADD CONSTRAINT "company_vote_ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_vote_sessions_company_id" ON "company_vote_sessions" USING btree ("company_id" uuid_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_vote_sessions_workspace_id" ON "company_vote_sessions" USING btree ("workspace_id" uuid_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_vote_sessions_deadline" ON "company_vote_sessions" USING btree ("status","deadline_at" timestamptz_ops);
--> statement-breakpoint
-- At most one open round per company: "Vote again" must conclude/cancel the
-- previous round first, and two racing "Start Vote" clicks cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_company_vote_sessions_one_active" ON "company_vote_sessions" USING btree ("company_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_vote_ballots_session_id" ON "company_vote_ballots" USING btree ("vote_session_id" uuid_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_vote_ballots_voter_id" ON "company_vote_ballots" USING btree ("voter_id" uuid_ops);
