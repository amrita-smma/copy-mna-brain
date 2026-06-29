-- [MB-344] Change entered_by from free-text to a UUID FK referencing users(id).

-- 1. Match free-text names to users by name — preserves historical attribution
--    where possible. Legacy entered_by holds display names (e.g. 'Budi', 'Admin'), not emails.
UPDATE companies c
SET entered_by = u.id::text
FROM users u
WHERE c.entered_by IS NOT NULL
  AND lower(c.entered_by) = lower(u.name);

-- 2. Null out anything that still isn't a valid UUID (unmatched names,
--    'AI Email Scanning', etc.).
UPDATE companies
SET entered_by = NULL
WHERE entered_by IS NOT NULL
  AND entered_by !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 3. Change column type (all remaining values are UUID strings or NULL).
ALTER TABLE companies
  ALTER COLUMN entered_by TYPE uuid USING entered_by::uuid;

-- 4. Add FK constraint.
ALTER TABLE companies
  ADD CONSTRAINT companies_entered_by_users_fkey
  FOREIGN KEY (entered_by) REFERENCES users(id) ON DELETE SET NULL;
