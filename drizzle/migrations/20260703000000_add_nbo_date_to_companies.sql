-- add_nbo_date_to_companies
-- NBO (Non-Binding Offer) due date for a company. A live deal (advisor set)
-- typically has an NBO date; surfaced on the company card and pipeline tables.
ALTER TABLE "companies" ADD COLUMN "nbo_date" date;
