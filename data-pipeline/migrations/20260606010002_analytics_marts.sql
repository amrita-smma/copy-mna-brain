SET search_path = analytics, public;

-- ─── dim_* (display-only views over the operational entities) ────────────────
CREATE OR REPLACE VIEW analytics.dim_employer
  WITH (security_invoker = on) AS
  SELECT id AS employer_id, name, industry FROM employer_effective;

CREATE OR REPLACE VIEW analytics.dim_correspondent
  WITH (security_invoker = on) AS
  SELECT id AS correspondent_id, employer_id, email, name FROM correspondent_effective;

CREATE OR REPLACE VIEW analytics.dim_topic
  WITH (security_invoker = on) AS
  SELECT id AS topic_id, slug, name FROM topics;

-- ─── mart_crm — one row per employer (CRM card KPIs) ─────────────────────────
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_crm;
CREATE MATERIALIZED VIEW analytics.mart_crm AS
SELECT
  e.id                                  AS employer_id,
  COALESCE(ec.email_count, 0)           AS email_count,
  ec.last_contact_at,
  rp.response_p50_seconds,
  COALESCE(rp.response_pair_count, 0)   AS response_pair_count
FROM employers e
-- email_count + last_contact via the participant path (matches list()).
LEFT JOIN (
  SELECT c.employer_id,
         COUNT(DISTINCT ep.email_id) AS email_count,
         MAX(em.sent_at)             AS last_contact_at
  FROM email_participants ep
  JOIN correspondents c ON c.id = ep.correspondent_id
  JOIN emails em        ON em.id = ep.email_id
  GROUP BY c.employer_id
) ec ON ec.employer_id = e.id
-- response p50: one earliest outbound reply per inbound email, gaps capped 30d.
LEFT JOIN (
  SELECT parent.employer_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap_seconds) AS response_p50_seconds,
         COUNT(*)                                                   AS response_pair_count
  FROM emails parent
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
  GROUP BY parent.employer_id
) rp ON rp.employer_id = e.id;

CREATE UNIQUE INDEX mart_crm_employer_id ON analytics.mart_crm (employer_id);

-- ─── mart_mom — employer × month volume + response p50 ───────────────────────
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_mom;
CREATE MATERIALIZED VIEW analytics.mart_mom AS
SELECT
  em.employer_id,
  date_trunc('month', em.sent_at)::date AS month,
  COUNT(*) FILTER (WHERE em.direction = 'inbound')  AS inbound,
  COUNT(*) FILTER (WHERE em.direction = 'outbound') AS outbound
FROM emails em
WHERE em.employer_id IS NOT NULL
GROUP BY em.employer_id, date_trunc('month', em.sent_at);

CREATE UNIQUE INDEX mart_mom_pk ON analytics.mart_mom (employer_id, month);

-- ─── mart_topics — topic × employer × month mention counts ───────────────────
DROP MATERIALIZED VIEW IF EXISTS analytics.mart_topics;
CREATE MATERIALIZED VIEW analytics.mart_topics AS
SELECT
  et.topic_id,
  em.employer_id,
  date_trunc('month', em.sent_at)::date AS month,
  COUNT(*) AS mentions
FROM email_topics et
JOIN emails em ON em.id = et.email_id
WHERE em.employer_id IS NOT NULL
GROUP BY et.topic_id, em.employer_id, date_trunc('month', em.sent_at);

CREATE UNIQUE INDEX mart_topics_pk ON analytics.mart_topics (topic_id, employer_id, month);
