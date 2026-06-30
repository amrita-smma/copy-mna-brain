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
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  aiWorkforceQueue,
  companies,
  companyAnalyses,
  companyLogs,
  companySlides,
  screenings,
} from '@/lib/db/schema';
import type { DbClient } from './types';

/** The L0–L5 deal-pipeline stages, in funnel order. Excludes `market_screening`
 * and `discovered`, which are not part of the origination funnel. */
export const PIPELINE_FUNNEL_STAGES = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;

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
}

/**
 * Read-only aggregation queries backing the dashboard Insights module:
 * funnel counts, segment / country / banker breakdowns, stale-deal candidates,
 * and AI throughput counters. All pipeline aggregates are scoped to active
 * companies in the L0–L5 funnel; `market_screening` and `discovered` rows are
 * excluded.
 */
export class DashboardInsightsRepository {
  constructor(private db: DbClient) {}

  /** Predicate: active company sitting in the L0–L5 funnel, created within the
   * `[from, to]` window. The window scopes every funnel/breakdown aggregate so
   * the dashboard's date filter (7d / 14d / custom) applies consistently. */
  private inFunnel(from: Date, to: Date) {
    return and(
      eq(companies.status, 'active'),
      inArray(companies.pipeline_stage, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
      gte(companies.created_at, from.toISOString()),
      lte(companies.created_at, to.toISOString()),
    );
  }

  /** Headcount per pipeline stage for active funnel companies created in the
   * window, grouped by their current stage. */
  async getStageCounts(from: Date, to: Date): Promise<{ stage: string; count: number }[]> {
    const rows = await this.db
      .select({ stage: companies.pipeline_stage, count: drizzleCount() })
      .from(companies)
      .where(this.inFunnel(from, to))
      .groupBy(companies.pipeline_stage);
    return rows.map((r) => ({ stage: String(r.stage), count: Number(r.count) }));
  }

  /** Count active funnel companies created in the window, grouped by an
   * arbitrary text key (a column or SQL expression) and pipeline stage. Shared
   * by the segment / country / banker breakdowns. */
  private async breakdownByKey(
    key: PgColumn | SQL,
    from: Date,
    to: Date,
  ): Promise<DimensionStageCount[]> {
    const rows = await this.db
      .select({ key, stage: companies.pipeline_stage, count: drizzleCount() })
      .from(companies)
      .where(this.inFunnel(from, to))
      .groupBy(key, companies.pipeline_stage);
    return rows.map((r) => ({
      key: r.key == null ? null : String(r.key),
      stage: String(r.stage),
      count: Number(r.count),
    }));
  }

  getSegmentBreakdown(from: Date, to: Date): Promise<DimensionStageCount[]> {
    return this.breakdownByKey(companies.segment, from, to);
  }

  getCountryBreakdown(from: Date, to: Date): Promise<DimensionStageCount[]> {
    return this.breakdownByKey(companies.geography, from, to);
  }

  /** Banker breakdown keyed on `banker`, falling back per-row to `banker_source`
   * when `banker` is empty (the column was added later, so older rows only have
   * `banker_source`). */
  getBankerBreakdown(from: Date, to: Date): Promise<DimensionStageCount[]> {
    return this.breakdownByKey(
      sql<string | null>`coalesce(nullif(${companies.banker}, ''), ${companies.banker_source})`,
      from,
      to,
    );
  }

  /** Active funnel deals (L0–L5) created within the window, with activity
   * timestamps, for staleness analysis. Which stages actually carry an SLA is
   * decided by the service (the configurable stale thresholds). */
  async getStaleCandidates(from: Date, to: Date): Promise<StaleCandidate[]> {
    const rows = await this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        pipeline_stage: companies.pipeline_stage,
        last_activity_at: companies.last_activity_at,
        created_at: companies.created_at,
        updated_at: companies.updated_at,
      })
      .from(companies)
      .where(
        and(
          eq(companies.status, 'active'),
          inArray(companies.pipeline_stage, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
          gte(companies.created_at, from.toISOString()),
          lte(companies.created_at, to.toISOString()),
        ),
      );
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

    const [row] = await this.db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT id) AS count FROM (
        SELECT ${companies.id} AS id
        FROM ${companies}
        WHERE ${eq(companies.pipeline_stage, 'L0')}
          AND ${gte(companies.created_at, fromIso)}
          AND ${lte(companies.created_at, toIso)}
        UNION
        SELECT ${companyLogs.company_id} AS id
        FROM ${companyLogs}
        WHERE ${like(companyLogs.action, '%_TO_L0')}
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
      .where(
        and(
          gte(companySlides.created_at, from.toISOString()),
          lte(companySlides.created_at, to.toISOString()),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /** AI Company Cards (`company_analyses`) created within the window, split by
   * terminal status. One row exists per company; re-generation overwrites it,
   * so `created_at` counts first-time card generations. */
  async getCompanyCardStats(from: Date, to: Date): Promise<CompanyCardStats> {
    const [row] = await this.db
      .select({
        total: drizzleCount(),
        completed: sql<number>`count(*) filter (where ${companyAnalyses.status} = 'completed')`,
        failed: sql<number>`count(*) filter (where ${companyAnalyses.status} = 'failed')`,
      })
      .from(companyAnalyses)
      .where(
        and(
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
      .where(
        and(
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
          gte(aiWorkforceQueue.created_at, from.toISOString()),
          lte(aiWorkforceQueue.created_at, to.toISOString()),
        ),
      );

    const [pendingRow] = await this.db
      .select({ value: drizzleCount() })
      .from(aiWorkforceQueue)
      .where(eq(aiWorkforceQueue.status, 'waiting_for_human_input'));

    return {
      resolved: Number(resolvedRow?.value ?? 0),
      pending: Number(pendingRow?.value ?? 0),
    };
  }
}
