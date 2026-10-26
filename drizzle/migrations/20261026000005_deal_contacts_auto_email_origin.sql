-- deal_contacts_auto_email_origin
-- Deal links from email mentions. A CRM contact who took part, as an external
-- participant, in an email that related-company evidence ties to a company of
-- the workspace is linked to that company as `involved`, origin `auto_email`,
-- unless the company is still `discovered`. See
-- docs/features/crm-banker-insights.md#deal-links.

-- 1. Allow the new origin (NOT VALID, then VALIDATE).
--
-- Lock: scripts/migrate.ts applies all pending app migrations in one
-- transaction, so the ACCESS EXCLUSIVE lock DROP CONSTRAINT takes on
-- deal_contacts is held until the backfill below commits. Reads and writes
-- of deal_contacts wait for the whole file.
ALTER TABLE deal_contacts DROP CONSTRAINT deal_contacts_origin_chk;

ALTER TABLE deal_contacts
  ADD CONSTRAINT deal_contacts_origin_chk
  CHECK (origin IN ('email_attachment', 'manual', 'confirmed_suggestion', 'auto_email')) NOT VALID;

ALTER TABLE deal_contacts VALIDATE CONSTRAINT deal_contacts_origin_chk;

-- 2. One-time backfill of every eligible pair, all workspaces.
--
-- This is a frozen copy of the runtime rule in
-- DealContactRepository.insertEmailMentionLinks, executed once; the app keeps
-- linking new mail itself after this. Same eligibility:
--   - related company not dismissed and resolved to a company of the same
--     workspace whose pipeline_stage is not 'discovered' (dropped included);
--   - the evidence email is attributed to that workspace (its custodian
--     mailbox belongs to a workspace member);
--   - the contact is on that email as an external participant (not an app
--     user, not at one of our own mail domains) and visible in the workspace;
--   - the pair has no deal_contacts row of any status (a removed link stays
--     removed; ON CONFLICT DO NOTHING covers a concurrent writer).
--
-- The analytics tables are created by data-pipeline/migrations, which run
-- after this folder, so on a fresh database they do not exist yet and there
-- is nothing to backfill.
DO $$
BEGIN
  IF to_regclass('analytics.employer_related_company_evidence') IS NOT NULL
     AND to_regclass('analytics.email_participants') IS NOT NULL
     AND to_regclass('analytics.emails') IS NOT NULL THEN
    INSERT INTO public.deal_contacts
      (workspace_id, company_id, correspondent_id, role, origin, status)
    SELECT DISTINCT erc.workspace_id, erc.company_id, ep.correspondent_id,
           'involved', 'auto_email', 'active'
    FROM public.employer_related_companies erc
    JOIN public.companies c
      ON c.id = erc.company_id
     AND c.workspace_id = erc.workspace_id
     AND c.pipeline_stage <> 'discovered'
    JOIN analytics.employer_related_company_evidence ev
      ON ev.related_company_id = erc.id
    JOIN analytics.email_participants ep
      ON ep.email_id = ev.email_id
     AND ep.user_id IS NULL
     AND ep.correspondent_id IS NOT NULL
    JOIN analytics.emails em ON em.id = ev.email_id
    WHERE erc.dismissed_at IS NULL
      AND erc.company_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.workspace_correspondents wc
        WHERE wc.workspace_id = erc.workspace_id
          AND wc.correspondent_id = ep.correspondent_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.users cu
        JOIN public.user_workspaces cuw ON cuw.user_id = cu.id
        WHERE cu.email = em.custodian_email
          AND cuw.workspace_id = erc.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE lower(u.email) = lower(ep.address)
      )
      -- Point-in-time copy of INTERNAL_MAIL_DOMAINS (src/lib/crm/mailDomains.ts)
      -- as of this migration; the runtime rule reads the live list.
      AND lower(substring(ep.address from '@([^@]*)$')) NOT IN (
        'starcapital.co.id', 'starcapitalholdings.com', 'smma.id',
        'sinarmasmining.com', 'techconnect.co.id', 'starhousecapital.sg',
        'frontiergroup.sg', 'hosanco.com', 'ebergroup.com', 'partners97.com',
        'kbru.co.id', 'starinvestama.co.id', 'sunterra.id', 'theolivelink.com',
        'sinarmas.co.id', 'sinarmas.org', 'startechgv.com', 'aldiracita.com',
        'adivira.com', 'lifewithsun.com', 'samantha.id', 'beraucoal.co.id',
        'essensrenewable.com', 'sinarmasland.com', 'banksinarmas.com'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.deal_contacts dc
        WHERE dc.workspace_id = erc.workspace_id
          AND dc.company_id = erc.company_id
          AND dc.correspondent_id = ep.correspondent_id
      )
    ON CONFLICT (workspace_id, company_id, correspondent_id) DO NOTHING;
  END IF;
END $$;
