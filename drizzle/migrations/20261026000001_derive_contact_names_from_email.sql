-- Name contacts that are still stored under their address from a person-shaped
-- address: matthieu.simoncini@firm.com -> "Matthieu Simoncini". Mirrors
-- `nameFromEmailLocalPart` / `GENERIC_MAILBOX_WORDS` in src/lib/crm/contactName.ts,
-- which ingest now applies to every new batch. Same guards as
-- `CorrespondentRepository.fillAddressLikeNames`: never a human-added row,
-- never a row that already has a real name.
WITH local_parts AS (
  SELECT
    co.id,
    split_part(split_part(lower(btrim(co.email)), '@', 1), '+', 1) AS local
  FROM correspondents co
  WHERE co.origin <> 'manual'
    AND co.email IS NOT NULL
    AND (
      COALESCE(btrim(co.name), '') = ''
      OR strpos(co.name, '@') > 0
      OR lower(btrim(co.name)) = lower(btrim(co.email))
    )
),
derived AS (
  SELECT id, initcap(regexp_replace(local, '[._-]', ' ', 'g')) AS name
  FROM local_parts
  WHERE local ~ '^[a-z]{2,}([._-][a-z]{2,}){1,2}$'
    AND NOT (regexp_split_to_array(local, '[._-]') && ARRAY[
      'account', 'accounts', 'admin', 'alerts', 'assistant', 'billing', 'bounce',
      'careers', 'compliance', 'contact', 'deal', 'deals', 'desk', 'enquiries',
      'enquiry', 'events', 'finance', 'group', 'hello', 'help', 'hr', 'info',
      'inquiries', 'investor', 'investors', 'invest', 'ir', 'jobs', 'kyc', 'legal',
      'mail', 'marketing', 'media', 'news', 'newsletter', 'no', 'noreply',
      'notifications', 'office', 'operations', 'ops', 'postmaster', 'press',
      'project', 'proposal', 'proposals', 'reception', 'relations', 'reply',
      'research', 'sales', 'secretary', 'service', 'services', 'support', 'team',
      'webmaster'
    ]::text[])
)
UPDATE correspondents co
SET name = d.name, updated_at = now()
FROM derived d
WHERE co.id = d.id;
