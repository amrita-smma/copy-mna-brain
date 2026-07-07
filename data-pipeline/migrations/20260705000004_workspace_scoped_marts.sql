-- Migration: CRM workspace scoping (MB-337 follow-up) — per-workspace KPI marts.
-- Created: 2026-07-05
--
-- Re-keys mart_crm/mart_mom/mart_topics by (workspace_id, employer_id, ...)
-- so CRM dashboard numbers (email volume, response p50, topic mentions)
-- reflect each workspace's own mailbox activity instead of one shared total.
--
-- The bridge from analytics.emails to a workspace is via message_id, NOT a
-- declared foreign key: analytics.emails has no raw_email_id column, but
-- both analytics.emails.message_id and analytics.raw_emails.message_id are
-- UNIQUE, and crmIngest always writes emails.message_id from the raw_emails
-- row it ingested — so the join is reliable even though Postgres/Drizzle
-- can't see it as a declared relationship. Comment kept here deliberately so
-- a future cleanup doesn't drop this join as "dead"/"unnecessary".
--
-- One email can map to more than one workspace (a custodian mailbox synced
-- to N workspaces) — that's an intentional one-to-many expansion, not a bug.
-- An email whose custodian never resolves to a synced workspace (unsynced
-- mailbox, non-user custodian, missing message_id) drops out of every
-- per-workspace mart entirely; it still counted toward the old global marts.
-- That's the intended semantics of "per-workspace KPI = this workspace's own
-- synced-mailbox activity", not a regression.
SET search_path = analytics, public;

CREATE OR REPLACE VIEW analytics.email_workspace
  WITH (security_invoker = on) AS
SELECT DISTINCT em.id AS email_id, uw.workspace_id
FROM analytics.emails em
JOIN analytics.raw_emails re ON re.message_id = em.message_id
JOIN public.users u ON u.email = re.custodian_email
JOIN public.user_workspaces uw ON uw.user_id = u.id AND uw.is_email_synced = true
WHERE em.message_id IS NOT NULL;

-- ─── mart_crm — one row per (workspace, employer) — CRM card KPIs ────────────
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_crm;
CREATE MATERIALIZED VIEW analytics.mart_crm AS
WITH ec AS (
  -- email_count + last_contact via the participant path (matches list()).
  SELECT ew.workspace_id,
         c.employer_id,
         COUNT(DISTINCT ep.email_id) AS email_count,
         MAX(em.sent_at)             AS last_contact_at
  FROM email_participants ep
  JOIN correspondents c  ON c.id  = ep.correspondent_id
  JOIN emails em          ON em.id = ep.email_id
  JOIN email_workspace ew ON ew.email_id = em.id
  GROUP BY ew.workspace_id, c.employer_id
),
rp AS (
  -- response p50: one earliest outbound reply per inbound email, gaps capped
  -- 30d. Attributed to the INBOUND email's workspace (the one whose
  -- responsiveness is being measured), not the reply's.
  SELECT ew.workspace_id,
         parent.employer_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap_seconds) AS response_p50_seconds,
         COUNT(*)                                                   AS response_pair_count
  FROM emails parent
  JOIN email_workspace ew ON ew.email_id = parent.id
  CROSS JOIN LATERAL (
    SELECT MIN(reply.sent_at) AS reply_at
    FROM emails reply
    WHERE reply.in_reply_to = parent.message_id
      AND reply.direction   = 'outbound'
      AND reply.sent_at      > parent.sent_at
  ) mr
  CROSS JOIN LATERAL (
    SELECT EXTRACT(EPOCH FROM (mr.reply_at - parent.sent_at)) AS gap_seconds
  ) g
  WHERE parent.direction   = 'inbound'
    AND parent.message_id IS NOT NULL
    AND mr.reply_at       IS NOT NULL
    AND mr.reply_at - parent.sent_at <= INTERVAL '30 days'
  GROUP BY ew.workspace_id, parent.employer_id
)
SELECT
  COALESCE(ec.workspace_id, rp.workspace_id) AS workspace_id,
  COALESCE(ec.employer_id, rp.employer_id)   AS employer_id,
  COALESCE(ec.email_count, 0)                AS email_count,
  ec.last_contact_at,
  rp.response_p50_seconds,
  COALESCE(rp.response_pair_count, 0)        AS response_pair_count
FROM ec
FULL OUTER JOIN rp
  ON rp.workspace_id = ec.workspace_id AND rp.employer_id = ec.employer_id;

CREATE UNIQUE INDEX mart_crm_workspace_employer ON analytics.mart_crm (workspace_id, employer_id);

-- ─── mart_mom — workspace × employer × month volume ──────────────────────────
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_mom;
CREATE MATERIALIZED VIEW analytics.mart_mom AS
SELECT
  ew.workspace_id,
  em.employer_id,
  date_trunc('month', em.sent_at)::date AS month,
  COUNT(*) FILTER (WHERE em.direction = 'inbound')  AS inbound,
  COUNT(*) FILTER (WHERE em.direction = 'outbound') AS outbound
FROM emails em
JOIN email_workspace ew ON ew.email_id = em.id
WHERE em.employer_id IS NOT NULL
GROUP BY ew.workspace_id, em.employer_id, date_trunc('month', em.sent_at);

CREATE UNIQUE INDEX mart_mom_pk ON analytics.mart_mom (workspace_id, employer_id, month);

-- ─── mart_topics — workspace × topic × employer × month mention counts ───────
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_topics;
CREATE MATERIALIZED VIEW analytics.mart_topics AS
SELECT
  ew.workspace_id,
  et.topic_id,
  em.employer_id,
  date_trunc('month', em.sent_at)::date AS month,
  COUNT(*) AS mentions
FROM email_topics et
JOIN emails em          ON em.id = et.email_id
JOIN email_workspace ew ON ew.email_id = em.id
WHERE em.employer_id IS NOT NULL
GROUP BY ew.workspace_id, et.topic_id, em.employer_id, date_trunc('month', em.sent_at);

CREATE UNIQUE INDEX mart_topics_pk ON analytics.mart_topics (workspace_id, topic_id, employer_id, month);
