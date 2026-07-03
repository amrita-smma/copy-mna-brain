-- add_is_live_to_companies
-- Explicit override for whether a deal is a "live" process. NULL means derive
-- from the presence of an advisor; TRUE/FALSE force the status regardless.
ALTER TABLE "companies" ADD COLUMN "is_live" boolean;
