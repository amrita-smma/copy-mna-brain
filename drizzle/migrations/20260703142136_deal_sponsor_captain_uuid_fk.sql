-- Change deal_sponsor / deal_captain from free-text names to UUID FKs
-- referencing users(id). Mirrors 20260626000004_entered_by_uuid_fk.sql.

-- 1. Match free-text names to users by name — preserves existing assignments
--    where possible. Legacy values hold display names (e.g. 'Dicki Sujadi').
UPDATE companies c
SET deal_sponsor = u.id::text
FROM users u
WHERE c.deal_sponsor IS NOT NULL
  AND lower(c.deal_sponsor) = lower(u.name);

UPDATE companies c
SET deal_captain = u.id::text
FROM users u
WHERE c.deal_captain IS NOT NULL
  AND lower(c.deal_captain) = lower(u.name);

-- 2. Null out anything that still isn't a valid UUID (unmatched names).
UPDATE companies
SET deal_sponsor = NULL
WHERE deal_sponsor IS NOT NULL
  AND deal_sponsor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE companies
SET deal_captain = NULL
WHERE deal_captain IS NOT NULL
  AND deal_captain !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 3. Change column types (all remaining values are UUID strings or NULL).
ALTER TABLE companies
  ALTER COLUMN deal_sponsor TYPE uuid USING deal_sponsor::uuid;

ALTER TABLE companies
  ALTER COLUMN deal_captain TYPE uuid USING deal_captain::uuid;

-- 4. Add FK constraints.
ALTER TABLE companies
  ADD CONSTRAINT companies_deal_sponsor_users_fkey
  FOREIGN KEY (deal_sponsor) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE companies
  ADD CONSTRAINT companies_deal_captain_users_fkey
  FOREIGN KEY (deal_captain) REFERENCES users(id) ON DELETE SET NULL;
