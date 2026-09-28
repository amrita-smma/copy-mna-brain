-- email_workspace_drop_sync_gate
--
-- CRM data must be visible to every member of a workspace regardless of
-- whether that member's mailbox has email sync toggled on.
--
-- analytics.email_workspace is the bridge that attributes an ingested email
-- to a workspace via its custodian. It required
-- `user_workspaces.is_email_synced = true` on the custodian's membership, so
-- toggling sync off for a person retroactively dropped every email they had
-- ever contributed out of mart_crm / mart_mom / mart_topics — the CRM card
-- KPIs (email volume, last contact, response p50, topic mentions) silently
-- fell back to zero for data that had already been ingested and was still
-- sitting in analytics.emails.
--
-- Sync state still governs which mailboxes the pipeline PULLS from
-- (`findSyncedCustodianEmails` / `findWorkspaceIdsBySyncedEmail` in
-- src/lib/repositories/userWorkspaceRepository.ts, and vaultArchiveStart) —
-- un-syncing still stops new email from being collected. It no longer hides
-- what was already collected. Mirrors the equivalent app-side change that
-- removed the `is_email_synced` EXISTS gates from the CRM reads in
-- correspondentRepository / employerRepository /
-- employerRelatedCompanyRepository / emailRepository.
SET search_path = analytics, public;

CREATE OR REPLACE VIEW analytics.email_workspace
  WITH (security_invoker = on) AS
SELECT DISTINCT em.id AS email_id, uw.workspace_id
FROM analytics.emails em
JOIN public.users u ON u.email = em.custodian_email
JOIN public.user_workspaces uw ON uw.user_id = u.id
WHERE em.custodian_email IS NOT NULL;

-- The marts are materialized off that view, so existing rows still carry the
-- old (gated) numbers until something refreshes them. Refresh here rather
-- than waiting for the next emailProcess run, otherwise the CRM cards keep
-- showing the pre-migration KPIs for an arbitrarily long time. Plain REFRESH
-- (not CONCURRENTLY): this runs inside the migration transaction.
DO $$
DECLARE
  view_name text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY['mart_crm', 'mart_mom', 'mart_topics'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_matviews
      WHERE schemaname = 'analytics' AND matviewname = view_name
    ) THEN
      EXECUTE format('REFRESH MATERIALIZED VIEW analytics.%I', view_name);
    END IF;
  END LOOP;
END $$;
