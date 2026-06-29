import {
  and,
  count as drizzleCount,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { aiWorkforceQueue, companies, companyLogs, companySlides } from '@/lib/db/schema';
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

  /** Predicate: active company sitting in the L0–L5 funnel. */
  private inFunnel() {
    return and(
      eq(companies.status, 'active'),
      inArray(companies.pipeline_stage, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
    );
  }

  /** Current headcount per pipeline stage (active funnel companies only). */
  async getStageCounts(): Promise<{ stage: string; count: number }[]> {
    const rows = await this.db
      .select({ stage: companies.pipeline_stage, count: drizzleCount() })
      .from(companies)
      .where(this.inFunnel())
      .groupBy(companies.pipeline_stage);
    return rows.map((r) => ({ stage: String(r.stage), count: Number(r.count) }));
  }

  /** Count active funnel companies grouped by an arbitrary text key (a column
   * or SQL expression) and pipeline stage. Shared by the segment / country /
   * banker breakdowns. */
  private async breakdownByKey(key: PgColumn | SQL): Promise<DimensionStageCount[]> {
    const rows = await this.db
      .select({ key, stage: companies.pipeline_stage, count: drizzleCount() })
      .from(companies)
      .where(this.inFunnel())
      .groupBy(key, companies.pipeline_stage);
    return rows.map((r) => ({
      key: r.key == null ? null : String(r.key),
      stage: String(r.stage),
      count: Number(r.count),
    }));
  }

  getSegmentBreakdown(): Promise<DimensionStageCount[]> {
    return this.breakdownByKey(companies.segment);
  }

  getCountryBreakdown(): Promise<DimensionStageCount[]> {
    return this.breakdownByKey(companies.geography);
  }

  /** Banker breakdown keyed on `banker`, falling back per-row to `banker_source`
   * when `banker` is empty (the column was added later, so older rows only have
   * `banker_source`). */
  getBankerBreakdown(): Promise<DimensionStageCount[]> {
    return this.breakdownByKey(
      sql<string | null>`coalesce(nullif(${companies.banker}, ''), ${companies.banker_source})`,
    );
  }

  /** Active deals past L0, with activity timestamps, for staleness analysis. */
  async getActiveNonL0Deals(): Promise<StaleCandidate[]> {
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
          inArray(companies.pipeline_stage, ['L1', 'L2', 'L3', 'L4', 'L5']),
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
