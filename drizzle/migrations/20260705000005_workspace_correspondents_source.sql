-- Migration: CRM workspace scoping (MB-337 follow-up) — provenance for
-- workspace_correspondents membership rows.
-- Created: 2026-07-05
--
-- Code review of the MB-337 CRM-scoping branch flagged an asymmetry:
-- analytics.email_workspace (20260705000004_workspace_scoped_marts.sql, the
-- pipeline migration) derives workspace visibility for KPI purposes live off
-- user_workspaces.is_email_synced — un-syncing a mailbox immediately drops
-- that workspace's mart numbers. workspace_correspondents has no equivalent:
-- it is add-only (see 20260705000000_add_workspace_correspondents.sql), so a
-- correspondent stays visible in a workspace's contact list forever once
-- granted, even after the custodian mailbox that surfaced it is un-synced.
--
-- A blanket "revoke everything on unsync" isn't safe without first knowing
-- WHY a membership row exists: a manually-added contact (CRMService.
-- createContact) has no ingest trail and must never be revoked just because
-- some unrelated mailbox in the workspace got un-synced. This column is that
-- provenance marker — the prerequisite for a future revoke-on-unsync sweep,
-- not the sweep itself (which additionally needs to track *which custodian*
-- granted a given ingest-sourced row, since one workspace can have multiple
-- synced mailboxes and revoking on one custodian's unsync must not remove
-- visibility another still-synced custodian legitimately grants — a separate,
-- larger design question, intentionally deferred).
--
-- Existing rows: the original backfill (20260705000000) granted MNA
-- visibility into every pre-existing correspondent — the overwhelming
-- majority came from mbox ingest, so 'ingest' is the correct default for
-- that historical data. Application code sets this explicitly on every new
-- write from this point on (WorkspaceCorrespondentRepository.addMembership(s)
-- now requires a source argument).
ALTER TABLE workspace_correspondents
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ingest';

ALTER TABLE workspace_correspondents
  ADD CONSTRAINT chk_workspace_correspondents_source CHECK (source IN ('ingest', 'manual'));
