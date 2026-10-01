-- ==============================================================================
-- RANDOMIZE COMPANY DATA IN THE "Demo" WORKSPACE
-- ==============================================================================
--
-- PURPOSE:
--   Rewrites the companies table for the workspace named 'Demo' with randomized
--   but realistic-looking values, and regenerates each company's company_logs
--   promotion history, so the Dashboard (pipeline funnel, inbound vs. outbound
--   split, New Deals / Dropped / Stage Moves recap tallies, deal sponsors/
--   captains, live-deal badges, AI Opinion column) renders as a fully populated
--   demo environment instead of a handful of sparse rows with zeroed-out recap
--   counters. All generated dates/timestamps (created_at, last_activity_at,
--   dropped_at, nbo_date, ai_opinion_updated_at, company_logs.created_at) fall
--   within the past 14 days so the demo always looks freshly active, no matter
--   when this script is run.
--
-- SCOPE:
--   Only touches rows whose workspace_id belongs to the workspace named 'Demo':
--   every column on `companies`, plus `company_logs` rows for those companies
--   (existing ones are deleted and replaced with a freshly generated promotion
--   trail). It does not touch any other workspace, and does not touch
--   deal_notes / deal_documents / users / any other table.
--
-- SAFETY NOTICE:
--   * This OVERWRITES existing column values on every company row in the Demo
--     workspace (pipeline_stage, source, segment, geography, ownership,
--     status/dropped fields, banker/advisor, stake/deal_size, workflow_status,
--     deal_sponsor/deal_captain/entered_by, created_at/last_activity_at,
--     ai_opinion_*), and DELETEs + regenerates every company_logs row for
--     those companies. This is intended for a demo/sandbox workspace only —
--     do not run it against a workspace with real deal data.
--   * If no workspace named exactly 'Demo' exists, every CTE/subquery below
--     resolves to zero rows and every statement is a no-op (0 rows affected)
--     — it will NOT fall back to touching another workspace.
--   * Wrapped in a transaction. Review the row counts after each statement
--     before COMMIT if running interactively (e.g. psql with ON_ERROR_STOP).
--
-- USAGE:
--   psql "$DATABASE_URL" -f scripts/randomize-demo-company-data.sql
-- ==============================================================================

BEGIN;

WITH tw AS (
  SELECT id
  FROM workspaces
  WHERE name = 'Demo'
  LIMIT 1
),
mem AS (
  SELECT COALESCE(array_agg(DISTINCT uw.user_id), ARRAY[]::uuid[]) AS user_ids
  FROM user_workspaces uw, tw
  WHERE uw.workspace_id = tw.id
),
rnd AS (
  SELECT
    c.id AS company_id,
    random() AS r_stage,
    random() AS r_status,
    random() AS r_source,
    random() AS r_advisor,
    random() AS r_islive,
    random() AS r_verdict,
    floor(random() * 10)::int AS i_segment,
    floor(random() * 10)::int AS i_geo,
    floor(random() * 6)::int AS i_ownership,
    floor(random() * 8)::int AS i_banker,
    floor(random() * 5)::int AS i_workflow_in,
    floor(random() * 5)::int AS i_workflow_out,
    floor(random() * 6)::int AS i_stake,
    floor(random() * 6)::int AS i_dealsize,
    floor(random() * 4)::int AS i_dropreason,
    -- Creation date anchors every other date on the row (last_activity_at,
    -- dropped_at, nbo_date) so they always fall chronologically ON OR AFTER
    -- creation while still landing inside the past 14 days.
    floor(random() * 15)::int AS i_created_days_ago,
    CASE WHEN array_length(mem.user_ids, 1) > 0
      THEN mem.user_ids[1 + floor(random() * array_length(mem.user_ids, 1))::int]
      ELSE NULL
    END AS sponsor_id,
    CASE WHEN array_length(mem.user_ids, 1) > 0
      THEN mem.user_ids[1 + floor(random() * array_length(mem.user_ids, 1))::int]
      ELSE NULL
    END AS captain_id,
    CASE WHEN array_length(mem.user_ids, 1) > 0
      THEN mem.user_ids[1 + floor(random() * array_length(mem.user_ids, 1))::int]
      ELSE NULL
    END AS entered_by_id,
    CASE WHEN array_length(mem.user_ids, 1) > 0
      THEN mem.user_ids[1 + floor(random() * array_length(mem.user_ids, 1))::int]
      ELSE NULL
    END AS dropped_by_id
  FROM companies c, tw, mem
  WHERE c.workspace_id = tw.id
),
calc AS (
  SELECT
    rnd.*,
    -- Each of these is bounded by the row's own i_created_days_ago so it never
    -- lands before the company's (also randomized) creation date.
    floor(random() * (rnd.i_created_days_ago + 1))::int AS i_days_activity_ago,
    floor(random() * (rnd.i_created_days_ago + 1))::int AS i_days_dropped_ago,
    floor(random() * (rnd.i_created_days_ago + 1))::int AS i_nbo_days_ago,
    -- Bias most rows into the L0-L5 funnel the Dashboard actually renders;
    -- a small slice stays in market_screening / unreviewed / discovered so
    -- Market Screening and Master Data aren't empty either.
    CASE
      WHEN r_stage < 0.06 THEN 'market_screening'
      WHEN r_stage < 0.11 THEN 'unreviewed'
      WHEN r_stage < 0.30 THEN 'L0'
      WHEN r_stage < 0.50 THEN 'L1'
      WHEN r_stage < 0.67 THEN 'L2'
      WHEN r_stage < 0.81 THEN 'L3'
      WHEN r_stage < 0.91 THEN 'L4'
      WHEN r_stage < 0.97 THEN 'L5'
      ELSE 'discovered'
    END AS new_stage,
    CASE WHEN r_status < 0.12 THEN 'dropped' ELSE 'active' END AS new_status,
    CASE WHEN r_source < 0.55 THEN 'inbound' ELSE 'outbound' END AS new_source,
    (ARRAY['Technology','Healthcare','Industrial Services','Consumer','Energy',
           'Logistics','Financial Services','Business Services','Infrastructure',
           'AI / SaaS'])[i_segment + 1] AS new_segment,
    (ARRAY['Indonesia','Singapore','Malaysia','Thailand','Vietnam','Philippines',
           'India','USA','Southeast Asia','Asia Pacific'])[i_geo + 1] AS new_geography,
    (ARRAY['Private','Family-owned','PE-backed','VC-backed','Listed',
           'Corporate carve-out'])[i_ownership + 1] AS new_ownership,
    (ARRAY['Golden Sacks','JP Organ','Organ Stanley','Evercore','Mandarin Sekuritas',
           'DIMB','KB Securities','Sundae Securities'])[i_banker + 1] AS new_banker,
    (ARRAY['Unreviewed','Teaser review','NDA pending','NDA executed',
           'L1 prep'])[i_workflow_in + 1] AS new_workflow_inbound,
    (ARRAY['Target identified','Intermediary approach','Direct outreach',
           'Market intel','Discussions ongoing'])[i_workflow_out + 1] AS new_workflow_outbound,
    (ARRAY['Target not interested','Lost to competing bidder','Valuation gap',
           'Deprioritized vs. other targets'])[i_dropreason + 1] AS new_drop_reason,
    (ARRAY['20%','25%','30%','51%','60%','100%'])[i_stake + 1] AS new_stake,
    (ARRAY['$15M','$22M','$48M','$95M','$120M','$180M'])[i_dealsize + 1] AS new_deal_size,
    CASE
      WHEN r_verdict < 0.45 THEN 'PASS'
      WHEN r_verdict < 0.75 THEN 'TENTATIVE'
      ELSE 'FAIL'
    END AS new_verdict
  FROM rnd
)
UPDATE companies c
SET
  pipeline_stage = calc.new_stage::pipeline_stage,
  status = calc.new_status::company_status,
  source = calc.new_source::deal_origin,
  segment = calc.new_segment,
  geography = calc.new_geography,
  ownership = calc.new_ownership,
  deal_type = CASE WHEN calc.new_stake IN ('20%','25%','30%') THEN 'minority' ELSE 'majority' END::deal_type,
  banker = calc.new_banker,
  advisor = CASE WHEN calc.new_stage IN ('L2','L3','L4','L5') AND calc.r_advisor < 0.6
                 THEN calc.new_banker ELSE NULL END,
  workflow_status = CASE WHEN calc.new_source = 'inbound'
                          THEN calc.new_workflow_inbound
                          ELSE calc.new_workflow_outbound END,
  stake = CASE WHEN calc.new_stage IN ('L1','L2','L3','L4','L5') THEN calc.new_stake ELSE NULL END,
  deal_size = CASE WHEN calc.new_stage IN ('L1','L2','L3','L4','L5') THEN calc.new_deal_size ELSE NULL END,
  is_live = CASE
              WHEN calc.r_islive < 0.08 THEN TRUE
              WHEN calc.r_islive < 0.14 THEN FALSE
              ELSE NULL
            END,
  nbo_date = CASE WHEN calc.new_stage IN ('L2','L3','L4','L5') AND calc.r_advisor < 0.6
                   THEN (CURRENT_DATE - calc.i_nbo_days_ago)
                   ELSE NULL END,
  deal_sponsor = calc.sponsor_id,
  deal_captain = calc.captain_id,
  entered_by = COALESCE(calc.entered_by_id, c.entered_by),
  dropped_reason = CASE WHEN calc.new_status = 'dropped' THEN calc.new_drop_reason ELSE NULL END,
  dropped_at = CASE WHEN calc.new_status = 'dropped'
                     THEN (now() - (calc.i_days_dropped_ago || ' days')::interval)
                     ELSE NULL END,
  dropped_by = CASE WHEN calc.new_status = 'dropped' THEN calc.dropped_by_id ELSE NULL END,
  resurface_at = NULL,
  -- Drives the Dashboard's "New Deals" / "Dropped" recap tally, which counts
  -- companies by created_at falling inside the selected date window.
  created_at = now() - (calc.i_created_days_ago || ' days')::interval,
  last_activity_at = now() - (calc.i_days_activity_ago || ' days')::interval,
  ai_opinion_verdict = CASE WHEN calc.new_stage IN ('L1','L2','L3','L4','L5') THEN calc.new_verdict ELSE NULL END,
  ai_opinion_summary = CASE WHEN calc.new_stage IN ('L1','L2','L3','L4','L5')
                             THEN 'AI Workforce verdict: ' || calc.new_verdict ||
                                  ' based on randomized demo screening criteria.'
                             ELSE NULL END,
  ai_opinion_status = CASE WHEN calc.new_stage IN ('L1','L2','L3','L4','L5') THEN 'completed' ELSE NULL END,
  ai_opinion_updated_at = CASE WHEN calc.new_stage IN ('L1','L2','L3','L4','L5')
                                THEN now() - (calc.i_days_activity_ago || ' days')::interval
                                ELSE NULL END,
  updated_at = now()
FROM calc
WHERE c.id = calc.company_id;

-- ==============================================================================
-- REBUILD company_logs SO "NEW DEALS" / "DROPPED" / "STAGE MOVES" AREN'T ZERO
-- ==============================================================================
-- The Dashboard's recap tally reads:
--   - "New Deals" (Inbound/Outbound) and "Dropped" (deals removed) from the
--     `companies` cohort bucketed by `created_at` / `status` — already covered
--     by the UPDATE above now that `created_at` is randomized into the window.
--   - "Stage Moves" from `company_logs` rows whose `action` matches
--     'PROMOTED_%' and whose `created_at` falls in the selected window (see
--     DashboardActivityService.getActivity -> DashboardActivityRepository
--     .getPipelineMoves). `companies` carries no history of how a deal reached
--     its current stage, so without seeding `company_logs` this tally stays 0
--     no matter how `pipeline_stage` is randomized above.
--
-- Clear out any existing logs on Demo companies first so re-running this
-- script doesn't pile up stale/inconsistent history from a previous
-- randomization pass, then regenerate one coherent promotion trail per
-- company — spaced between its (new) created_at and last_activity_at, so
-- every log row still lands inside the same past-14-days window.

DELETE FROM company_logs cl
USING companies c, workspaces w
WHERE cl.company_id = c.id
  AND c.workspace_id = w.id
  AND w.name = 'Demo';

-- Pipeline entry marker, timestamped at each company's (new) creation date.
INSERT INTO company_logs (company_id, action, user_id, created_at)
SELECT c.id, 'CREATED_AS_L0', c.deal_sponsor, c.created_at
FROM companies c, workspaces w
WHERE c.workspace_id = w.id
  AND w.name = 'Demo'
  AND c.pipeline_stage IN ('L0', 'L1', 'L2', 'L3', 'L4', 'L5');

-- One PROMOTED_FROM_L<n>_TO_L<n+1> row per stage the company has climbed
-- through (an L3 company gets L0->L1, L1->L2, L2->L3), evenly spaced between
-- created_at and last_activity_at.
INSERT INTO company_logs (company_id, action, user_id, created_at)
SELECT
  dc.id,
  'PROMOTED_FROM_L' || (s - 1) || '_TO_L' || s,
  dc.deal_sponsor,
  dc.created_at + (GREATEST(dc.last_activity_at, dc.created_at) - dc.created_at)
                  * (s::numeric / (dc.stage_num + 1))
FROM (
  SELECT
    c.id,
    c.created_at,
    COALESCE(c.last_activity_at, now()) AS last_activity_at,
    c.deal_sponsor,
    CASE c.pipeline_stage
      WHEN 'L1' THEN 1 WHEN 'L2' THEN 2 WHEN 'L3' THEN 3
      WHEN 'L4' THEN 4 WHEN 'L5' THEN 5 ELSE 0
    END AS stage_num
  FROM companies c, workspaces w
  WHERE c.workspace_id = w.id
    AND w.name = 'Demo'
) dc
CROSS JOIN LATERAL generate_series(1, dc.stage_num) AS s;

-- Review the affected row counts before committing when running interactively.
-- \echo 'Done.'   -- (psql only)

COMMIT;
