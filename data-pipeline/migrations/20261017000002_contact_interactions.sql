-- contact_interactions
--
-- Per-person CRM interaction numbers (MB-854): for each (workspace, contact,
-- team member) pair, how many emails went each way and when the last one was.
--
--   mart_contact_interactions  materialized, EMAILS ONLY. No now()-relative
--                              columns: a materialized view freezes them at
--                              refresh time. Refreshed with the other marts
--                              (MART_VIEWS in martRepository.ts).
--   mart_contact_email_totals  materialized, one row per (workspace, contact):
--                              DISTINCT emails each way under the same pair
--                              rule. Not the sum of the per-member rows — one
--                              email from the contact to two colleagues is
--                              one email here, one per colleague above.
--
-- A team member is an app user (participant row with user_id) who is a member
-- of the workspace the email is attributed to. A contact is a
-- participant row with correspondent_id and NO user_id, at a different address
-- than the team member — an address that belongs to an app user is never the
-- contact side, so a colleague who also exists as a CRM contact cannot pair
-- with themselves.

SET search_path = analytics, public;

DROP MATERIALIZED VIEW IF EXISTS analytics.mart_contact_email_totals;
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_contact_interactions;
CREATE MATERIALIZED VIEW analytics.mart_contact_interactions AS
SELECT
  ew.workspace_id,
  cp.correspondent_id,
  up.user_id,
  (count(DISTINCT em.id) FILTER (
    WHERE up.role = 'from' AND cp.role IN ('to', 'cc')
  ))::int AS emails_from_us,
  (count(DISTINCT em.id) FILTER (
    WHERE cp.role = 'from' AND up.role IN ('to', 'cc')
  ))::int AS emails_from_them,
  max(em.sent_at) AS last_email_at
FROM analytics.emails em
JOIN analytics.email_workspace ew ON ew.email_id = em.id
JOIN analytics.email_participants up
  ON up.email_id = em.id
 AND up.user_id IS NOT NULL
JOIN public.user_workspaces uw
  ON uw.user_id = up.user_id
 AND uw.workspace_id = ew.workspace_id
JOIN analytics.email_participants cp
  ON cp.email_id = em.id
 AND cp.correspondent_id IS NOT NULL
 AND cp.user_id IS NULL
 AND cp.address <> up.address
-- Only a direct exchange between the two counts: one of them is the sender
-- and the other a to/cc recipient. Two people cc'd on the same thread are not
-- an interaction, and bcc is never counted.
WHERE (up.role = 'from' AND cp.role IN ('to', 'cc'))
   OR (cp.role = 'from' AND up.role IN ('to', 'cc'))
GROUP BY ew.workspace_id, cp.correspondent_id, up.user_id;

-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY. Its (workspace_id,
-- correspondent_id) prefix also serves the per-contact / bulk reads, so there
-- is no separate index on those two columns.
CREATE UNIQUE INDEX mart_contact_interactions_workspace_contact_user
  ON analytics.mart_contact_interactions (workspace_id, correspondent_id, user_id);

-- Per-contact email totals (sorting and the contact scorecard read these). The
-- FROM / JOIN / WHERE is mart_contact_interactions' pair rule verbatim — change
-- both together. An email counts for the contact when it pairs with at least
-- one workspace member; grouping without user_id plus count(DISTINCT) collapses
-- the colleagues it paired with to one.
CREATE MATERIALIZED VIEW analytics.mart_contact_email_totals AS
SELECT
  ew.workspace_id,
  cp.correspondent_id,
  (count(DISTINCT em.id) FILTER (
    WHERE up.role = 'from' AND cp.role IN ('to', 'cc')
  ))::int AS emails_from_us,
  (count(DISTINCT em.id) FILTER (
    WHERE cp.role = 'from' AND up.role IN ('to', 'cc')
  ))::int AS emails_from_them,
  max(em.sent_at) AS last_email_at
FROM analytics.emails em
JOIN analytics.email_workspace ew ON ew.email_id = em.id
JOIN analytics.email_participants up
  ON up.email_id = em.id
 AND up.user_id IS NOT NULL
JOIN public.user_workspaces uw
  ON uw.user_id = up.user_id
 AND uw.workspace_id = ew.workspace_id
JOIN analytics.email_participants cp
  ON cp.email_id = em.id
 AND cp.correspondent_id IS NOT NULL
 AND cp.user_id IS NULL
 AND cp.address <> up.address
WHERE (up.role = 'from' AND cp.role IN ('to', 'cc'))
   OR (cp.role = 'from' AND up.role IN ('to', 'cc'))
GROUP BY ew.workspace_id, cp.correspondent_id;

-- Required by REFRESH ... CONCURRENTLY; also the bulk-read key.
CREATE UNIQUE INDEX mart_contact_email_totals_workspace_contact
  ON analytics.mart_contact_email_totals (workspace_id, correspondent_id);
