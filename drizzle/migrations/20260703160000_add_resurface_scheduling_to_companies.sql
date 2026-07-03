-- add_resurface_scheduling_to_companies
-- Optional automatic resurfacing of dropped deals. `resurface_at` is set from
-- the drop dialog ("resurface in 1/3/6/12 months or a custom date"); a cron
-- sweep reactivates due deals, notes why, and emails the PIC + the dropper.
-- `dropped_by` records who dropped the deal so they can be notified.
ALTER TABLE "companies" ADD COLUMN "resurface_at" timestamp with time zone;
ALTER TABLE "companies" ADD COLUMN "dropped_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- Partial index: the cron sweep only ever scans dropped deals with a pending
-- resurface date, which is a tiny slice of the table.
CREATE INDEX "idx_companies_resurface_due"
  ON "companies" ("resurface_at")
  WHERE "status" = 'dropped' AND "resurface_at" IS NOT NULL;
