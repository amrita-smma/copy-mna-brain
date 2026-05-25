-- Adds a coarser category bucket alongside the free-text `industry` column.
-- Used to render the "Inv. Bank" / "Boutique" tag line on the CRM card while
-- keeping `industry` free to hold the more specific focus ("SemiCon",
-- "Chemicals", …).

ALTER TABLE employers
  ADD COLUMN IF NOT EXISTS industry_category TEXT;
