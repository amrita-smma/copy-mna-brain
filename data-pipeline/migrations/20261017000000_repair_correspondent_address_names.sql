-- repair_correspondent_address_names
--
-- One-off repair for ingested contacts whose name is "address-like" — empty,
-- containing '@', or equal to their email (case-insensitive), the same rule as
-- `isAddressLikeName` in src/lib/crm/contactName.ts. Such a contact takes the
-- display name from the most recent email it SENT, when that display name is
-- a real name (non-empty, no '@').
--
-- Lives in the pipeline set because it reads analytics.emails: pipeline
-- migrations run after the app set, and nothing in public may depend on
-- analytics.
--
-- Scope: base `correspondents.name` only. Manual contacts (origin = 'manual')
-- and the human overlay (`correspondent_curation`) are never touched.
-- Idempotent: a repaired name is no longer address-like, so a re-run matches
-- nothing; with no emails it is a no-op.

UPDATE public.correspondents AS c
SET name = best.display_name,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (lower(e.from_address))
    lower(e.from_address) AS address,
    btrim(e.from_display_name) AS display_name
  FROM analytics.emails e
  WHERE e.from_address IS NOT NULL
    AND btrim(COALESCE(e.from_display_name, '')) <> ''
    AND strpos(e.from_display_name, '@') = 0
  ORDER BY lower(e.from_address), e.sent_at DESC NULLS LAST
) AS best
WHERE c.origin <> 'manual'
  AND c.email IS NOT NULL
  AND lower(btrim(c.email)) = best.address
  AND (
    COALESCE(btrim(c.name), '') = ''
    OR strpos(c.name, '@') > 0
    OR lower(btrim(c.name)) = lower(btrim(c.email))
  );
