-- Sector and region the relationship overview job infers from a contact's
-- emails. Shown only as an "AI-inferred" fallback where the contact's stated
-- Industry Focus / Area Focus (correspondents.specialization /
-- coverage_region) is empty; never copied into those columns, which banker
-- matching searches.
ALTER TABLE contact_relationship_overviews
  ADD COLUMN IF NOT EXISTS inferred_industry_focus text,
  ADD COLUMN IF NOT EXISTS inferred_area_focus text;
