-- Free-form markdown "Context" recorded on a company, surfaced in the company
-- card's Context tab above the timeline notes. Fed to the AI Opinion run, the
-- slide/company-card generators, and the agent read tools so human-written
-- background is taken into account alongside the structured columns.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "context" text;
