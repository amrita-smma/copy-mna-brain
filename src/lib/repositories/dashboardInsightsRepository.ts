import {
  and,
  count as drizzleCount,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  aiWorkforceQueue,
  companies,
  companyAnalyses,
  companyLogs,
  companySlides,
  screenings,
  users,
} from '@/lib/db/schema';
import type { DbClient } from './types';

/** The original L0–L5 deal-pipeline stages, in funnel order — the default when
 * a caller does not pass the workspace's own live stages. Excludes
 * `market_screening`, `unreviewed` and `discovered`, which are not part of the
 * origination funnel. */
export const PIPELINE_FUNNEL_STAGES: readonly string[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/**
 * Coerce a Postgres `array_agg` result into a `number[]`. Depending on the
 * driver the value arrives either as a JS array (`[1, 2, 3]`) or as a Postgres
 * array literal string (`"{1,2,3}"`); both — plus null — are normalized here so
 * callers can map/filter without a runtime type crash.
 */
function toNumberArray(value: (string | number)[] | string | null | undefined): number[] {
  if (value == null) return [];
  const items = Array.isArray(value)
    ? value
    : value.replace(/^\{|\}$/g, '').split(',').filter((s) => s.length > 0);
  return items.map((g) => Number(g));
}

/** A `(dimension value, pipeline stage)` count — the raw shape the service
 * pivots into per-segment / per-country / per-banker rows. */
export interface DimensionStageCount {
  key: string | null;
  stage: string;
  count: number;
}

/** AI Company Cards (`company_analyses`) generated in the window, split by the
 * terminal status of the generation run. */
export interface CompanyCardStats {
  total: number;
  completed: number;
  failed: number;
}

/** AI Opinion verdicts (`companies.ai_opinion_*`) recorded in the window. Each
 * company carries at most one current opinion, so these are latest-per-company
 * counts, not a full history. */
export interface AiOpinionStats {
  total: number;
  pass: number;
  fail: number;
  tentative: number;
}

/** AI screening runs (`screenings`) that produced a result in the window,
 * counted at the per-criteria row grain plus the distinct companies touched. */
export interface ScreeningStats {
  companiesScreened: number;
  total: number;
  pass: number;
  fail: number;
  inconclusive: number;
  error: number;
}

/** Active deal in a stage past L0, with the timestamps needed to compute how
 * long it has sat without activity. */
export interface StaleCandidate {
  id: string;
  target: string | null;
  project_name: string | null;
  pipeline_stage: string;
  last_activity_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Resolved deal-sponsor name (uuid FK → users), null when unset. */
  deal_sponsor_name: string | null;
  /** Resolved deal-captain name (uuid FK → users), null when unset. */
  deal_captain_name: string | null;
  /** Descriptive fields backing the matched-Track PIC fallback. */
  segment: string | null;
  geography: string | null;
  thesis_content: string | null;
  matched_track_ids: string[] | null;
}

/**
 * Read-only aggregation queries backing the dashboard Insights module:
 * funnel counts, segment / country / banker breakdowns, stale-deal candidates,
 * and AI throughput counters. All pipeline aggregates are scoped to active
 * companies in the pipeline funnel (the stages the caller passes); `market_screening` and `discovered` rows are
 * excluded.
 */
export class DashboardInsightsRepository {
  constructor(
    private db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /** Predicate: active company sitting in the given funnel stages, created within the
   * `[from, to]` window. The window scopes every funnel/breakdown aggregate so
   * the dashboard's date filter (7d / 14d / custom) applies consistently. */
  private inFunnel(from: Date, to: Date, stages: readonly string[]) {
    return and(
      eq(companies.workspace_id, this.workspaceId),
      eq(companies.status, 'active'),
      inArray(companies.pipeline_stage, [...stages]),
      gte(companies.created_at, from.toISOString()),
      lte(companies.created_at, to.toISOString()),
    );
  }

  /** Headcount per pipeline stage for active funnel companies created in the
   * window, grouped by their current stage. */
  async getStageCounts(
    from: Date,
    to: Date,
    stages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<{ stage: string; count: number }[]> {
    if (stages.length === 0) return [];
    const rows = await this.db
      .select({ stage: companies.pipeline_stage, count: drizzleCount() })
      .from(companies)
      .where(this.inFunnel(from, to, stages))
      .groupBy(companies.pipeline_stage);
    return rows.map((r) => ({ stage: String(r.stage), count: Number(r.count) }));
  }

  /** Headcount per pipeline stage for **dropped** funnel companies created in
   * the window. Used alongside {@link getStageCounts} to form the full L0 cohort
   * (active + dropped) for the L0→L1 conversion rate. */
  async getDroppedStageCounts(
    from: Date,
    to: Date,
    stages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<{ stage: string; count: number }[]> {
    if (stages.length === 0) return [];
    const rows = await this.db
      .select({ stage: companies.pipeline_stage, count: drizzleCount() })
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          eq(companies.status, 'dropped'),
          inArray(companies.pipeline_stage, [...stages]),
          gte(companies.created_at, from.toISOString()),
          lte(companies.created_at, to.toISOString()),
        ),
      )
      .groupBy(companies.pipeline_stage);
    return rows.map((r) => ({ stage: String(r.stage), count: Number(r.count) }));
  }

  /**
   * Companies *added to* each funnel stage within the window — the flow
   * into a stage, not the current snapshot. A company counts toward a stage when
   * it was either created directly at that stage in the window, or moved into it
   * via a stage-change log (`…_TO_L<n>`: promotions, resurfaces, restores) whose
   * timestamp falls in the window. This generalises {@link countNewDeals} (the
   * L0 case) across every stage, so a company promoted through several stages in
   * the window is counted once per stage it entered. Distinct per stage.
   */
  async getStageEntryCounts(
    from: Date,
    to: Date,
    funnelStages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<{ stage: string; count: number }[]> {
    if (funnelStages.length === 0) return [];
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const stages = [...funnelStages];

    const { rows } = await this.db.execute<{ stage: string; count: string }>(sql`
      SELECT stage, COUNT(DISTINCT id) AS count FROM (
        SELECT ${companies.id} AS id, ${companies.pipeline_stage}::text AS stage
        FROM ${companies}
        WHERE ${eq(companies.workspace_id, this.workspaceId)}
          AND ${inArray(companies.pipeline_stage, stages)}
          AND ${gte(companies.created_at, fromIso)}
          AND ${lte(companies.created_at, toIso)}
        UNION
        SELECT ${companyLogs.company_id} AS id,
               substring(${companyLogs.action} from '_TO_(.+)$') AS stage
        FROM ${companyLogs}
        INNER JOIN ${companies} ON ${eq(companies.id, companyLogs.company_id)}
        WHERE ${eq(companies.workspace_id, this.workspaceId)}
          AND ${like(companyLogs.action, '%\\_TO\\_%')}
          AND ${gte(companyLogs.created_at, fromIso)}
          AND ${lte(companyLogs.created_at, toIso)}
      ) sub
      WHERE ${inArray(sql`stage`, stages)}
      GROUP BY stage
    `);
    return rows.map((r) => ({ stage: String(r.stage), count: Number(r.count) }));
  }

  /**
   * Cohort breakdown keyed on `key`: companies **created in the window** that are
   * currently a pipeline deal (a funnel stage), grouped by the key and their **current**
   * stage. This is the deal-funnel basis — a snapshot of where each company sits
   * *today* (active and dropped alike, each counted once), matching
   * `DashboardActivityService.getAddedCohort` (the "New Deals" tally). Because it
   * shares that method's exact `[from, to]` created-at window and funnel-stage filter,
   * summing these per-key/per-stage counts reconciles with the New Deals figure.
   * It deliberately differs from the stage-entry model in
   * {@link getStageEntryCounts}, which counts *entries* into each stage (via
   * `…_TO_L<n>` logs, so a resurfaced or promoted company created before the
   * window still counts); rolling these per-stage counts up cumulatively (a
   * company at L1 today also passed through L0) is done in the service.
   */
  private async cohortBreakdownByKey(
    key: SQL,
    from: Date,
    to: Date,
    funnelStages: readonly string[],
  ): Promise<DimensionStageCount[]> {
    if (funnelStages.length === 0) return [];
    const stages = [...funnelStages];
    const { rows } = await this.db.execute<{ key: string | null; stage: string; count: string }>(sql`
      SELECT ${key} AS key,
             ${companies.pipeline_stage}::text AS stage,
             COUNT(*) AS count
      FROM ${companies}
      WHERE ${eq(companies.workspace_id, this.workspaceId)}
        AND ${inArray(companies.pipeline_stage, stages)}
        AND ${gte(companies.created_at, from.toISOString())}
        AND ${lte(companies.created_at, to.toISOString())}
      GROUP BY ${key}, ${companies.pipeline_stage}
    `);
    return rows.map((r) => ({
      key: r.key == null ? null : String(r.key),
      stage: String(r.stage),
      count: Number(r.count),
    }));
  }

  /** Segment breakdown on the deal-funnel (cohort-by-current-stage) basis, so it
   * tallies with the "New Deals" cohort. */
  getSegmentBreakdown(
    from: Date,
    to: Date,
    stages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<DimensionStageCount[]> {
    return this.cohortBreakdownByKey(sql`${companies.segment}`, from, to, stages);
  }

  /** Country breakdown on the deal-funnel (cohort-by-current-stage) basis, so it
   * tallies with the "New Deals" cohort. */
  getCountryBreakdown(
    from: Date,
    to: Date,
    stages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<DimensionStageCount[]> {
    return this.cohortBreakdownByKey(sql`${companies.geography}`, from, to, stages);
  }

  /** Banker breakdown for **inbound** companies created in the window, keyed on
   * the company's `banker` / `banker_source` field. Only inbound deals are
   * counted so "Leads from Bankers" matches the Recap panel's inbound cohort.
   * Rows with no banker name are dropped downstream (`buildBreakdown` skips blank
   * keys). */
  async getBankerBreakdown(
    from: Date,
    to: Date,
    funnelStages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<DimensionStageCount[]> {
    if (funnelStages.length === 0) return [];
    const stages = [...funnelStages];
    const { rows } = await this.db.execute<{ key: string | null; stage: string; count: string }>(sql`
      SELECT coalesce(nullif(${companies.banker}, ''), ${companies.banker_source}) AS key,
             ${companies.pipeline_stage}::text AS stage,
             COUNT(*) AS count
      FROM ${companies}
      WHERE ${eq(companies.workspace_id, this.workspaceId)}
        AND ${inArray(companies.pipeline_stage, stages)}
        AND ${gte(companies.created_at, from.toISOString())}
        AND ${lte(companies.created_at, to.toISOString())}
        AND ${eq(companies.source, 'inbound')}
      GROUP BY key, ${companies.pipeline_stage}
    `);
    return rows.map((r) => ({
      key: r.key == null ? null : String(r.key),
      stage: String(r.stage),
      count: Number(r.count),
    }));
  }

  /**
   * Per banker firm (employer) in this workspace, our email response-time
   * profile: the firm name, the median seconds we take to reply, the reply-pair
   * sample size, and the full list of gap seconds (for a per-firm distribution
   * sparkline). Computed live from `analytics.emails` — one earliest outbound
   * reply per inbound email, gaps capped at 30 days — using the same logic as
   * the `mart_crm` response p50, but returning the raw gaps rather than only
   * the median. Workspace scoping is via the `analytics.email_workspace` bridge
   * (emails.custodian_email → users → user_workspaces — every membership, not
   * only email-synced ones; see 20260928000000_email_workspace_drop_sync_gate).
   *
   * Defensive: the analytics tables are produced by the data pipeline and may
   * be absent in some environments, so any failure yields `[]` rather than
   * failing the whole Insights response.
   */
  async getBankerResponseProfiles(): Promise<
    { name: string; p50Seconds: number; pairCount: number; gaps: number[] }[]
  > {
    try {
      const { rows } = await this.db.execute<{
        name: string;
        p50_seconds: string | number;
        pair_count: string | number;
        // `array_agg` may come back either as a JS array or as a Postgres array
        // literal string (e.g. "{1,2,3}") depending on the driver — normalized
        // by `toNumberArray` below.
        gaps: (string | number)[] | string | null;
      }>(sql`
        SELECT e.name AS name,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY sub.gap_seconds) AS p50_seconds,
               count(*) AS pair_count,
               array_agg(sub.gap_seconds ORDER BY sub.gap_seconds) AS gaps
        FROM (
          SELECT parent.employer_id AS employer_id,
                 EXTRACT(EPOCH FROM (mr.reply_at - parent.sent_at)) AS gap_seconds
          FROM "analytics"."emails" parent
          JOIN "analytics"."email_workspace" ew
            ON ew.email_id = parent.id AND ew.workspace_id = ${this.workspaceId}
          CROSS JOIN LATERAL (
            SELECT MIN(reply.sent_at) AS reply_at
            FROM "analytics"."emails" reply
            WHERE reply.in_reply_to = parent.message_id
              AND reply.direction = 'outbound'
              AND reply.sent_at > parent.sent_at
          ) mr
          WHERE parent.direction = 'inbound'
            AND parent.message_id IS NOT NULL
            AND parent.employer_id IS NOT NULL
            AND mr.reply_at IS NOT NULL
            AND mr.reply_at - parent.sent_at <= INTERVAL '30 days'
        ) sub
        JOIN "public"."employers" e ON e.id = sub.employer_id
        GROUP BY e.name
      `);
      return rows.map((r) => ({
        name: String(r.name),
        p50Seconds: Number(r.p50_seconds),
        pairCount: Number(r.pair_count),
        gaps: toNumberArray(r.gaps).filter((n) => Number.isFinite(n) && n >= 0),
      }));
    } catch (err) {
      console.warn('getBankerResponseProfiles: analytics tables unavailable', err);
      return [];
    }
  }

  /** Active funnel deals created within the window, with activity
   * timestamps, for staleness analysis. Which stages actually carry an SLA is
   * decided by the service (the configurable stale thresholds). The deal
   * sponsor/captain names are resolved via joins so the stale list can show who
   * owns each deal. */
  async getStaleCandidates(
    from: Date,
    to: Date,
    stages: readonly string[] = PIPELINE_FUNNEL_STAGES,
  ): Promise<StaleCandidate[]> {
    if (stages.length === 0) return [];
    const sponsorUsers = alias(users, 'stale_sponsor_users');
    const captainUsers = alias(users, 'stale_captain_users');
    const rows = await this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        pipeline_stage: companies.pipeline_stage,
        last_activity_at: companies.last_activity_at,
        created_at: companies.created_at,
        updated_at: companies.updated_at,
        deal_sponsor_name: sponsorUsers.name,
        deal_captain_name: captainUsers.name,
        // Descriptive fields for the matched-Track PIC fallback (see the
        // service's `resolveLeadName`).
        segment: companies.segment,
        geography: companies.geography,
        thesis_content: companies.thesis_content,
        matched_track_ids: companies.matched_track_ids,
      })
      .from(companies)
      .leftJoin(sponsorUsers, eq(sponsorUsers.id, companies.deal_sponsor))
      .leftJoin(captainUsers, eq(captainUsers.id, companies.deal_captain))
      .where(this.inFunnel(from, to, stages));
    return rows.map((r) => ({ ...r, pipeline_stage: String(r.pipeline_stage) }));
  }

  private async countWhere(where: SQL | undefined): Promise<number> {
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(companies)
      .where(where);
    return Number(row?.value ?? 0);
  }

  /** Companies new to L0 within the window: created at L0 OR promoted/demoted TO L0. */
  async countNewDeals(from: Date, to: Date): Promise<number> {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const { rows: [row] } = await this.db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT id) AS count FROM (
        SELECT ${companies.id} AS id
        FROM ${companies}
        WHERE ${eq(companies.workspace_id, this.workspaceId)}
          AND ${eq(companies.pipeline_stage, 'L0')}
          AND ${gte(companies.created_at, fromIso)}
          AND ${lte(companies.created_at, toIso)}
        UNION
        SELECT ${companyLogs.company_id} AS id
        FROM ${companyLogs}
        INNER JOIN ${companies} ON ${eq(companies.id, companyLogs.company_id)}
        WHERE ${eq(companies.workspace_id, this.workspaceId)}
          AND ${like(companyLogs.action, '%_TO_L0')}
          AND ${gte(companyLogs.created_at, fromIso)}
          AND ${lte(companyLogs.created_at, toIso)}
      ) sub
    `);
    return Number(row?.count ?? 0);
  }

  /** Companies created directly at L0 within the window (AI screening output). */
  countScreenedL0(from: Date, to: Date): Promise<number> {
    return this.countWhere(
      and(
        eq(companies.workspace_id, this.workspaceId),
        eq(companies.status, 'active'),
        eq(companies.pipeline_stage, 'L0'),
        gte(companies.created_at, from.toISOString()),
        lte(companies.created_at, to.toISOString()),
      ),
    );
  }

  /** Company decks (slides) generated within the window. */
  async countDecksGenerated(from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(companySlides)
      .innerJoin(companies, eq(companies.id, companySlides.company_id))
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          gte(companySlides.created_at, from.toISOString()),
          lte(companySlides.created_at, to.toISOString()),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /** AI Company Cards (`company_analyses`) generated within the window, split
   * by terminal status. One row exists per company and a completed run
   * re-stamps `created_at` (it is the card's "content produced at" timestamp —
   * see `@/lib/companies/cardFreshness`), so this counts card *generations* in
   * the window, regenerations included, not only first-time ones. */
  async getCompanyCardStats(from: Date, to: Date): Promise<CompanyCardStats> {
    const [row] = await this.db
      .select({
        total: drizzleCount(),
        completed: sql<number>`count(*) filter (where ${companyAnalyses.status} = 'completed')`,
        failed: sql<number>`count(*) filter (where ${companyAnalyses.status} = 'failed')`,
      })
      .from(companyAnalyses)
      .innerJoin(companies, eq(companies.id, companyAnalyses.company_id))
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          gte(companyAnalyses.created_at, from.toISOString()),
          lte(companyAnalyses.created_at, to.toISOString()),
        ),
      );
    return {
      total: Number(row?.total ?? 0),
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  /** AI Opinion verdicts recorded within the window, keyed off
   * `ai_opinion_updated_at`. Only companies with a verdict are counted, and the
   * pass/fail/tentative split sums to `total`. */
  async getAiOpinionStats(from: Date, to: Date): Promise<AiOpinionStats> {
    const [row] = await this.db
      .select({
        total: drizzleCount(),
        pass: sql<number>`count(*) filter (where ${companies.ai_opinion_verdict} = 'pass')`,
        fail: sql<number>`count(*) filter (where ${companies.ai_opinion_verdict} = 'fail')`,
        tentative: sql<number>`count(*) filter (where ${companies.ai_opinion_verdict} = 'tentative')`,
      })
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          isNotNull(companies.ai_opinion_verdict),
          gte(companies.ai_opinion_updated_at, from.toISOString()),
          lte(companies.ai_opinion_updated_at, to.toISOString()),
        ),
      );
    return {
      total: Number(row?.total ?? 0),
      pass: Number(row?.pass ?? 0),
      fail: Number(row?.fail ?? 0),
      tentative: Number(row?.tentative ?? 0),
    };
  }

  /** AI screening runs that produced a result within the window (per-criteria
   * rows), with the result breakdown and the distinct companies screened.
   * Rows still `pending` (no result yet) are excluded. */
  async getScreeningStats(from: Date, to: Date): Promise<ScreeningStats> {
    const [row] = await this.db
      .select({
        companiesScreened: sql<number>`count(distinct ${screenings.company_id})`,
        total: drizzleCount(),
        pass: sql<number>`count(*) filter (where ${screenings.result} = 'pass')`,
        fail: sql<number>`count(*) filter (where ${screenings.result} = 'fail')`,
        inconclusive: sql<number>`count(*) filter (where ${screenings.result} = 'inconclusive')`,
        error: sql<number>`count(*) filter (where ${screenings.result} = 'error')`,
      })
      .from(screenings)
      .innerJoin(companies, eq(companies.id, screenings.company_id))
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          isNotNull(screenings.result),
          gte(screenings.created_at, from.toISOString()),
          lte(screenings.created_at, to.toISOString()),
        ),
      );
    return {
      companiesScreened: Number(row?.companiesScreened ?? 0),
      total: Number(row?.total ?? 0),
      pass: Number(row?.pass ?? 0),
      fail: Number(row?.fail ?? 0),
      inconclusive: Number(row?.inconclusive ?? 0),
      error: Number(row?.error ?? 0),
    };
  }

  /** Top-level AI Workforce runs (parent runs) started within the window. */
  async countWorkforceRuns(from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
          isNull(aiWorkforceQueue.parent_run_id),
          gte(aiWorkforceQueue.created_at, from.toISOString()),
          lte(aiWorkforceQueue.created_at, to.toISOString()),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /**
   * HITL (human-in-the-loop) intervention stats:
   * - `resolved`: total decisions recorded across runs started in the window
   *   (each element of `human_decisions` is one resolved intervention).
   * - `pending`: runs currently parked awaiting a human decision (a snapshot,
   *   not window-scoped — pending work is always "now").
   */
  async getHitlStats(from: Date, to: Date): Promise<{ resolved: number; pending: number }> {
    const [resolvedRow] = await this.db
      .select({
        value: sql<number>`coalesce(sum(jsonb_array_length(${aiWorkforceQueue.human_decisions})), 0)`,
      })
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
          gte(aiWorkforceQueue.created_at, from.toISOString()),
          lte(aiWorkforceQueue.created_at, to.toISOString()),
        ),
      );

    const [pendingRow] = await this.db
      .select({ value: drizzleCount() })
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
          eq(aiWorkforceQueue.status, 'waiting_for_human_input'),
        ),
      );

    return {
      resolved: Number(resolvedRow?.value ?? 0),
      pending: Number(pendingRow?.value ?? 0),
    };
  }
}
