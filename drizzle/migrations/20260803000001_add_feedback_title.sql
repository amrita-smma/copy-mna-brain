ALTER TABLE "feedback" ADD COLUMN "title" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "title" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
