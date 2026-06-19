-- Seed unreviewed companies for MB-223/224/225/226 development
-- Run after pnpm db:migrate

INSERT INTO companies (
  target, segment, geography, source, pipeline_stage, status,
  review_state, doc_type, banker_source, remarks
) VALUES
  -- Teasers (inbound)
  ('PT Sinar Teknologi', 'Technology', 'Indonesia', 'inbound', 'L0', 'active',
   'unreviewed', 'teaser', 'Goldman Sachs', 'Extracted from Goldman Sachs teaser, Jun 2026'),
  ('Mega Retail Group', 'Retail', 'Indonesia', 'inbound', 'L0', 'active',
   'unreviewed', 'teaser', 'JP Morgan', 'Extracted from JP Morgan teaser, Jun 2026'),
  ('Archipelago Logistics', 'Logistics', 'Southeast Asia', 'inbound', 'L0', 'active',
   'unreviewed', 'teaser', 'Morgan Stanley', 'Extracted from Morgan Stanley teaser, Jun 2026'),
  -- Shopping lists (inbound)
  ('BrightStar Energy', 'Energy', 'Indonesia', 'inbound', 'L0', 'active',
   'unreviewed', 'shopping_list', 'UBS', 'Extracted from UBS shopping list, Jun 2026'),
  ('Nusantara Health', 'Healthcare', 'Indonesia', 'inbound', 'L0', 'active',
   'unreviewed', 'shopping_list', 'Citi', 'Extracted from Citi shopping list, Jun 2026'),
  -- Market study (inbound — actively pitched)
  ('Pacific Chemicals Ltd', 'Chemicals', 'Asia Pacific', 'inbound', 'L0', 'active',
   'unreviewed', 'market_study', 'Deutsche Bank', 'Extracted from DB APAC Chemicals study, Jun 2026. Actively pitched.'),
  -- Market study (outbound — referenced as benchmark)
  ('ASEAN Plastics Co', 'Chemicals', 'Southeast Asia', 'outbound', 'L0', 'active',
   'unreviewed', 'market_study', 'Deutsche Bank', 'Extracted from DB APAC Chemicals study, Jun 2026. Referenced as market benchmark — not actively pitched.');

-- Add a possible duplicate flag to one row (references an existing company if one exists)
-- UPDATE companies SET possible_duplicate_company_id = '<existing-company-uuid>'
-- WHERE target = 'Pacific Chemicals Ltd';
