-- Migration: CRM workspace scoping (MB-337 follow-up) — distinguish
-- mailbox-sync ingest from direct workspace-attributed ingest.
-- Created: 2026-07-05
--
-- 20260705000005_workspace_correspondents_source.sql added 'ingest'/'manual'
-- provenance so ingest-derived correspondents could be gated on
-- user_workspaces.is_email_synced while manually-added ones stay durable.
-- That conflated two different write paths under 'ingest':
--
--   1. crmIngest (data-pipeline) — the real mailbox-sync pipeline. Every row
--      is backed by a message_id-bearing analytics.emails row tied to a
--      custodian mailbox, genuinely governed by is_email_synced.
--   2. CRMService.ingestEmails (Google Vault export / file-extracted
--      communications, called from vaultExport.ts / fileService.ts) —
--      writes correspondents/emails with NO message_id and no mailbox
--      concept at all. Never governed by any sync state, but was labeled
--      'ingest' anyway, so the sync gate could hide it forever.
--
-- Not shipped anywhere: this table and its 'source' column only exist on
-- this branch (confirmed absent from main and from the PR's own base,
-- feature-branch/multitenancy) — no historical production data carries the
-- old conflated labeling, so no backfill is needed here, just the
-- constraint widening. Application code (CRMService.upsertCorrespondent)
-- is updated in the same change to write 'direct' instead of 'ingest' for
-- this path going forward.
ALTER TABLE workspace_correspondents
  DROP CONSTRAINT chk_workspace_correspondents_source;

ALTER TABLE workspace_correspondents
  ADD CONSTRAINT chk_workspace_correspondents_source CHECK (source IN ('ingest', 'manual', 'direct'));
